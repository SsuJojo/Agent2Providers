#!/usr/bin/env node
/**
 * 生成私有发布清单：把上游 `pack.json` 改成本仓库的包身份。
 *
 * ── 为什么要有这一步 ────────────────────────────────────────
 * 这份仓库跟踪上游 `ProvidersPlugin/Agent2Providers`，上游清单的 id 是
 * `agent2api-providers`。直接拿它打包，产物会和官方包同 id：网关的
 * `ownership` 让非官方包优先接管同名 provider，于是一个旧版私有包会把
 * 官方新版的全部实现整体顶掉 —— 余额查询失败就是这么来的。
 *
 * 所以发布前必须换 id。但**不能把改写后的清单提交回分支**：那会让仓库
 * 的 `pack.json` 不再等于上游，下一次 `git merge upstream/beta` 就变成
 * 真冲突（或者更好笑的：官方清单被私有 id 覆盖，再打包时 id 又是对的，
 * 谁也没发现源码已经漂了）。这里改成「构建时生成、不落库」。
 *
 * ── provider 全集为什么必须校验 ─────────────────────────────
 * 私有包是官方 provider 包的**替代品**，不是增量补丁：网关按 provider
 * 归属选路，账号记录里的 provider id 是落盘契约。私有包少一家，那家的
 * 账号就没有执行体。所以生成清单时要求「私有 id + 官方 provider 全集」，
 * 任何一家缺失都直接让构建失败，而不是发出一个悄悄少了功能的包。
 *
 * 用法：
 *   node scripts/release-manifest.mjs --check          # 只校验，不写文件
 *   node scripts/release-manifest.mjs --out pack.json  # 写入发布清单
 *   node scripts/release-manifest.mjs --out dist/pack.json \
 *     --upstream /path/to/upstream/pack.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')

/** 私有包 id。改它等于换一个包，已安装的旧包不会被原地升级。 */
export const PRIVATE_PACK_ID = 'ssujojo-providers'

/** 私有包名（界面显示）。 */
export const PRIVATE_PACK_NAME = 'SsuJojo 提供商'

/** 私有包的展示描述（保留上游能力说明，补一句来源）。 */
const PRIVATE_PACK_DESCRIPTION =
  '基于官方提供商增强同步的私有构建，包含本仓库的本地修复；与官方包同 id 的 provider 由本包接管。'

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function providerIds(manifest) {
  const ids = (manifest.providers || []).map(item => String(item?.id ?? ''))
  if (ids.some(id => !id)) throw new Error('pack.json 里有 provider 缺少 id')
  return ids
}

/**
 * 校验一份「私有发布清单」是否还能完整替代官方包。
 *
 * `upstream` 是上游清单（可以缺省）；给出时要求 provider 集合完全一致。
 * 不给时至少要求清单非空 —— 一个空清单的包能装、能启，但谁都不服务。
 */
export function validateReleaseManifest(manifest, upstream) {
  const problems = []
  if (manifest.id !== PRIVATE_PACK_ID) {
    problems.push(`id 必须是 ${PRIVATE_PACK_ID}，实际是 ${manifest.id}`)
  }
  const ids = providerIds(manifest)
  if (!ids.length) problems.push('providers 为空：这个包不会接管任何提供商')
  if (new Set(ids).size !== ids.length) {
    const seen = new Set()
    const dupes = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)))
    problems.push(`providers 有重复 id：${[...new Set(dupes)].join(', ')}`)
  }
  if (!manifest.entry || !Object.keys(manifest.entry).length) {
    problems.push('entry 为空：没有任何平台的入口二进制')
  }
  for (const [target, path] of Object.entries(manifest.entry || {})) {
    if (typeof path !== 'string' || !path.trim()) {
      problems.push(`entry.${target} 不是有效路径`)
    }
  }
  if (upstream) {
    const expected = providerIds(upstream)
    const missing = expected.filter(id => !ids.includes(id))
    const extra = ids.filter(id => !expected.includes(id))
    if (missing.length) {
      problems.push(
        `缺少上游 provider（私有包是官方包的替代品，少一家就有账号没有执行体）：${missing.join(', ')}`,
      )
    }
    if (extra.length) {
      problems.push(`多出上游没有的 provider（会与其它包抢归属，需确认来源）：${extra.join(', ')}`)
    }
  }
  return problems
}

/**
 * 把上游清单改写成私有发布清单。
 *
 * 只动身份字段（id / name / description / homepage）；provider 列表、
 * entry、ui、icons 全部原样沿用上游，保证「同一份能力，只换一个包 id」。
 */
export function rewriteManifest(upstream) {
  // 入口文件名跟着包 id 走：`bin/agent2api-providers` → `bin/ssujojo-providers`。
  // 二进制**编译产物名**仍是上游的（cargo 包名不变），只有包内路径改名 ——
  // 网关只认清单里的 entry，不关心 cargo 怎么叫它。
  const entry = Object.fromEntries(
    Object.entries(upstream.entry || {}).map(([target, path]) => [
      target,
      String(path).replace(/(^|\/)agent2api-providers(\.exe)?$/, (_match, prefix, ext) =>
        `${prefix}${PRIVATE_PACK_ID}${ext ?? ''}`),
    ]),
  )
  return {
    ...upstream,
    id: PRIVATE_PACK_ID,
    name: PRIVATE_PACK_NAME,
    description: PRIVATE_PACK_DESCRIPTION,
    homepage: 'https://github.com/SsuJojo/Agent2Providers',
    entry,
  }
}

function parseArgs(argv) {
  const options = {
    out: '',
    check: false,
    upstream: join(PLUGIN_DIR, 'pack.json'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = resolve(argv[++index] || '')
    else if (arg === '--upstream') options.upstream = resolve(argv[++index] || '')
    else if (arg === '--check') options.check = true
    else {
      console.error(`未知参数：${arg}`)
      console.error('用法: node scripts/release-manifest.mjs [--out <路径>] [--upstream <路径>] [--check]')
      process.exit(2)
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.upstream)) {
    console.error(`[manifest] 找不到上游清单：${options.upstream}`)
    process.exit(1)
  }
  const upstream = readManifest(options.upstream)
  const release = rewriteManifest(upstream)
  const problems = validateReleaseManifest(release, upstream)
  if (problems.length) {
    console.error('[manifest] 发布清单不合格：')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  if (options.check) {
    console.log(
      `[manifest] OK：${release.id} v${release.version}，${release.providers.length} 家（与上游一致）`,
    )
    return
  }
  if (!options.out) {
    console.error('[manifest] 需要 --out <路径>（或 --check 只校验）')
    process.exit(2)
  }
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, `${JSON.stringify(release, null, 2)}\n`, 'utf8')
  console.log(
    `[manifest] 已写入 ${options.out}：${release.id} v${release.version}，${release.providers.length} 家`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
