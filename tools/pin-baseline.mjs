#!/usr/bin/env node
/**
 * Re-download the pristine baseline PINNED to the exact upstream revision the
 * working checkout was taken from.
 *
 * Why this exists: jsdelivr's `@main` moves. Fetching "pristine" from `@main`
 * later can silently return a NEWER revision than the working copy, and then the
 * generated patch set contains diffs for files nobody meant to touch. That
 * happened once (two `tests/orca-link-*.spec.ts` files).
 *
 * The fix is to stop asking for "main" and ask for the exact blobs instead:
 * `build/.upstream/tree.json`, captured when the working copy was downloaded,
 * records the blob SHA of every file at that revision. Fetching by SHA cannot
 * drift.
 *
 *   node build/pin-baseline.mjs [--verify]
 *
 * Writes build/pristine/<path>. With --verify it only reports, and additionally
 * checks that every file NOT in the known-changed set matches the working copy.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TREE = join(HERE, '.upstream', 'tree.json')
const WORKING = join(HERE, '.upstream')
const PRISTINE = join(HERE, 'pristine')
const OWNER = 'zhu1090093659'
const REPO = 'dsh-skins'
const VERIFY_ONLY = process.argv.includes('--verify')

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

async function fetchBlob(sha, attempt = 0) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${sha}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-skin-center-mod-pin',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      return fetchBlob(sha, attempt + 1)
    }
    throw new Error(`blob ${sha}: HTTP ${res.status}`)
  }
  const json = await res.json()
  return Buffer.from(json.content, 'base64')
}

/** A small worker pool: the API is fast but 100+ sequential round trips is slow. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

const tree = JSON.parse(readFileSync(TREE, 'utf8'))
// scripts/ is included because the CLI is part of the patch set. Leaving it out
// hid a real omission: regen-patches.mjs could not see a scripts/ change, so it
// reported the group as "no change" instead of publishing it.
const files = tree.tree.filter((e) => e.type === 'blob' && /^(src|tests|scripts)\//.test(e.path))

console.log(`tree sha  : ${tree.sha}`)
console.log(`files     : ${files.length}`)

const results = await mapLimit(files, 8, async (entry) => {
  const bytes = await fetchBlob(entry.sha)
  if (bytes === null) return { path: entry.path, missing: true }
  return { path: entry.path, bytes }
})

let written = 0
let missing = 0
const mismatches = []
for (const r of results) {
  if (r.missing) {
    missing += 1
    console.log(`  MISSING upstream: ${r.path}`)
    continue
  }
  const workPath = join(WORKING, r.path)
  const work = existsSync(workPath) ? readFileSync(workPath) : null
  const matches = work !== null && work.equals(r.bytes)
  if (!matches) mismatches.push(r.path)
  if (!VERIFY_ONLY) {
    const dest = join(PRISTINE, r.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, r.bytes)
    written += 1
  }
}

console.log(`\nmissing upstream : ${missing}`)
console.log(`differ from work : ${mismatches.length}`)
for (const p of mismatches) console.log(`    ${p}`)
if (!VERIFY_ONLY) console.log(`\nwrote ${written} pinned baseline file(s) to build/pristine/`)
