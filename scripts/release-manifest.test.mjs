#!/usr/bin/env node
/**
 * 发布清单的回归用例。
 *
 * 这几条断言守的是「私有包能替代官方包」这件事本身：id 换掉、provider
 * 全集不缩水、入口路径跟着 id 走。改坏任何一条，产物仍然能装、能起，
 * 但会静默抢走官方 provider 或让某家账号没有执行体 —— 那正是这次要
 * 根除的故障形态，所以必须在构建阶段就红。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRIVATE_PACK_ID,
  rewriteManifest,
  validateReleaseManifest,
} from './release-manifest.mjs'

const upstream = {
  id: 'agent2api-providers',
  name: '提供商增强',
  version: '9.9.9',
  protocol: 1,
  providers: [
    { id: 'workbuddy', label: 'WorkBuddy 国内版', order: 15, default_enabled: true },
    { id: 'zcode', label: 'ZCode 国内版', order: 13, default_enabled: true },
  ],
  entry: {
    'x86_64-unknown-linux-gnu': 'bin/agent2api-providers',
    'x86_64-pc-windows-msvc': 'bin/agent2api-providers.exe',
  },
}

test('发布清单换掉包 id，并保留上游全部 provider', () => {
  const release = rewriteManifest(upstream)
  assert.equal(release.id, PRIVATE_PACK_ID)
  assert.deepEqual(
    release.providers.map(item => item.id),
    upstream.providers.map(item => item.id),
  )
  assert.equal(release.version, upstream.version)
  assert.deepEqual(validateReleaseManifest(release, upstream), [])
})

test('入口路径跟着私有 id 走（否则包内指向官方二进制名）', () => {
  const release = rewriteManifest(upstream)
  assert.equal(release.entry['x86_64-unknown-linux-gnu'], 'bin/ssujojo-providers')
  assert.equal(release.entry['x86_64-pc-windows-msvc'], 'bin/ssujojo-providers.exe')
})

test('少一家 provider 必须失败：账号会没有执行体', () => {
  const release = rewriteManifest(upstream)
  release.providers = release.providers.filter(item => item.id !== 'zcode')
  const problems = validateReleaseManifest(release, upstream)
  assert.ok(problems.some(text => text.includes('zcode')), problems.join('; '))
})

test('id 没换成私有 id 必须失败：会与官方包抢归属', () => {
  const problems = validateReleaseManifest({ ...upstream }, undefined)
  assert.ok(problems.some(text => text.includes('id 必须是')), problems.join('; '))
})

test('重复 provider id 必须失败：归属表只有一个赢家', () => {
  const release = rewriteManifest(upstream)
  release.providers.push({ ...release.providers[0] })
  const problems = validateReleaseManifest(release, undefined)
  assert.ok(problems.some(text => text.includes('重复')), problems.join('; '))
})
