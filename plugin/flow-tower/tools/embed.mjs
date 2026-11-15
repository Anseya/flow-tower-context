#!/usr/bin/env node
/**
 * Backfill optional embedding vectors for a project dictionary.
 *
 * Run:
 *   FLOW_TOWER_EMBEDDING_KEY=... node tools/embed.mjs \
 *     --project=<abs root> --endpoint=https://api.openai.com/v1/embeddings \
 *     --model=text-embedding-3-small [--limit=2000]
 *
 * No endpoint → no network; search keeps using lexical/sparse retrieval.
 */

import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import { createEmbeddingProvider } from '../lib/embeddings.js'

const args = process.argv.slice(2)
const project = normalizeProjectPath(args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd())
const endpoint = args.find((arg) => arg.startsWith('--endpoint='))?.slice('--endpoint='.length) ?? process.env.FLOW_TOWER_EMBEDDING_ENDPOINT ?? ''
const model = args.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? process.env.FLOW_TOWER_EMBEDDING_MODEL ?? 'text-embedding-3-small'
const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length) ?? 2000)
if (endpoint.length === 0) {
  process.stderr.write('missing --endpoint (or FLOW_TOWER_EMBEDDING_ENDPOINT); nothing to do\n')
  process.exit(2)
}
const provider = createEmbeddingProvider({ embeddingEndpoint: endpoint, embeddingModel: model })
if (provider === null) {
  process.stderr.write('cannot create embedding provider\n')
  process.exit(2)
}
const store = FlowStore.open({ dbPath: dbPathForProject(project) })
try {
  const volumes = store.listVolumes({ limit: 1000 })
  let embedded = 0
  let skipped = 0
  for (const volume of volumes) {
    const entries = store.listEntries(volume.volumeId, { limit: Math.max(1, Math.min(20000, limit)) })
    const batch = []
    for (const entry of entries) {
      if (store.getEntryVector(entry.entryId) !== null) { skipped += 1; continue }
      batch.push(entry)
    }
    for (let offset = 0; offset < batch.length; offset += 32) {
      const chunk = batch.slice(offset, offset + 32)
      const texts = chunk.map((entry) => `${entry.headword}\n${entry.gloss ?? ''}\n${entry.module ?? ''}`)
      const vectors = await provider.embed(texts)
      vectors.forEach((vector, index) => {
        store.setEntryVector(chunk[index].entryId, chunk[index].volumeId, provider.model, vector)
        embedded += 1
      })
      process.stdout.write(`embedded ${embedded}/${batch.length} (volume ${volume.volumeId})\n`)
    }
  }
  process.stdout.write(`done: embedded=${embedded} skipped=${skipped} model=${provider.model}\n`)
} finally {
  store.close()
}
