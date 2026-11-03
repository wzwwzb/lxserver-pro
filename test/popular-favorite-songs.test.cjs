const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')
const { PopularFavoriteSongsService } = require('../server/server/popularFavoriteSongs')

const item = id => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }],
    al: { id: 5, name: 'Album', picUrl: 'https://example.test/cover.jpg' }, dt: 200000, l: { size: 1000 } })

function fixture(values = { 1: 999999, 2: 1000000, 3: 2500000 }) {
    let now = 1700000000000
    let calls = []
    let mode = 'ok'
    const getter = async url => {
        const u = new URL(url)
        calls.push(u.pathname)
        if (mode === 'failed') throw new Error('upstream failed')
        if (u.pathname === '/api/v6/playlist/detail') return { code: 200,
            playlist: { trackIds: Object.keys(values).map(id => ({ id: +id })), updateTime: 1699999000000 } }
        if (u.pathname === '/api/v3/song/detail') {
            const ids = JSON.parse(u.searchParams.get('ids')).reverse()
            return { code: 200, songs: ids.map(item), privileges: ids.map(id => ({ id })) }
        }
        if (u.pathname === '/api/song/red/count') {
            const id = Number(u.searchParams.get('songId'))
            if (values[id] === 'error') throw new Error('one count failed')
            if (values[id] === 'rate-limit') return { code: 429 }
            return { code: 200, data: { count: values[id] } }
        }
        throw new Error('unexpected URL')
    }
    return { service: new PopularFavoriteSongsService(getter, () => now, async ms => { now += ms }),
        calls, advance: ms => { now += ms }, fail: () => { mode = 'failed' } }
}

test('popular songs use actual per-song heart counts, preserve rank and strictly enforce threshold', async () => {
    const f = fixture({ 1: 999999, 2: 1000000, 3: 2500000, 4: null, 5: '3000000' })
    const result = await f.service.get()
    assert.deepEqual(result.song.map(s => [s.music.id, s.favoriteCount]), [['wy_2', 1000000], ['wy_3', 2500000]])
    assert.equal(result.source, 'netease')
    assert.equal(result.chartId, '6723173524')
    assert.equal(result.chartUpdatedAtMs, 1699999000000)
    assert.equal(result.partial, true, 'invalid counts are skipped and explicitly reported')
    assert.equal(result.scannedCount, 5)
    assert.equal(result.cacheTtlMs, 600000)
    assert.ok(result.song.every(s => s.favoriteUpdatedAtMs <= result.updatedAtMs))
    await f.service.get()
    assert.equal(f.calls.length, 7, 'partial result is cached')
})

test('concurrent requests coalesce and valid results cache for six hours', async () => {
    const f = fixture()
    const all = await Promise.all(Array.from({ length: 20 }, () => f.service.get()))
    assert.ok(all.every(x => x.song.length === 2 && !x.partial && !x.stale))
    assert.equal(f.calls.filter(x => x.includes('playlist/detail')).length, 1)
    assert.equal(f.calls.filter(x => x.endsWith('red/count')).length, 3)
    assert.equal(all[0].cacheTtlMs, 21600000)
    f.advance(21500000)
    await f.service.get()
    assert.equal(f.calls.length, 5)
})

test('failed refresh returns a labeled bounded stale cache and backs off', async () => {
    const f = fixture()
    const first = await f.service.get()
    f.advance(21600001)
    f.fail()
    const stale = await f.service.get()
    assert.equal(stale.stale, true)
    assert.equal(stale.updatedAtMs, first.updatedAtMs)
    const calls = f.calls.length
    assert.equal((await f.service.get()).stale, true)
    assert.equal(f.calls.length, calls)
    f.advance(24 * 60 * 60 * 1000)
    await assert.rejects(f.service.get())
})

test('three consecutive count failures stop requests and never fabricate a result', async () => {
    const f = fixture({ 1: 1100000, 2: 'error', 3: 'error', 4: 'error', 5: 3000000 })
    const result = await f.service.get()
    assert.equal(result.partial, true)
    assert.deepEqual(result.song.map(x => x.music.id), ['wy_1'])
    assert.equal(result.scannedCount, 4)
    assert.equal(f.calls.filter(x => x.endsWith('red/count')).length, 4)
})

test('candidate cap and provider rate limits bound upstream requests', async () => {
    const many = fixture(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [i + 1, 3])))
    const limited = await many.service.get()
    assert.equal(limited.chartSongCount, 80)
    assert.equal(limited.candidateCount, 40)
    assert.equal(limited.scannedCount, 40)
    assert.equal(limited.song.length, 0)
    const rateLimited = fixture({ 1: 1500000, 2: 'rate-limit', 3: 2000000 })
    const partial = await rateLimited.service.get()
    assert.deepEqual(partial.song.map(x => x.music.id), ['wy_1'])
    assert.equal(partial.partial, true)
    assert.equal(partial.scannedCount, 2)
})

test('authenticated GET and POST expose only verified results and protect URL credentials', { timeout: 60000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-popular-'))
    const data = path.join(tmp, 'data'), logs = path.join(tmp, 'logs')
    fs.mkdirSync(data); fs.mkdirSync(logs)
    const users = [{ name: 'alice', password: 'fixture-popular-password' }]
    fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(users))
    const configPath = path.join(tmp, 'config.js')
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({ users, 'admin.password': 'fixture-admin',
        'subsonic.enable': true, 'subsonic.enableDebug': true, 'webdav.enable': false,
        'configBackup.enable': false, disableTelemetry: true })}`)
    const preload = path.join(tmp, 'preload.cjs')
    fs.writeFileSync(preload, `
const realFetch = global.fetch;
global.fetch = async (value, options) => {
  const u = new URL(value);
  if (u.hostname !== 'music.163.com') return realFetch(value, options);
  let d;
  if (u.pathname === '/api/v6/playlist/detail') d = {code:200, playlist:{trackIds:[{id:11},{id:22}], updateTime:1699999000000}};
  else if (u.pathname === '/api/v3/song/detail') d = {code:200,
    songs:[11,22].map(id => ({id,name:'Song '+id,ar:[{name:'Artist'}],al:{id:5,name:'Album'},dt:200000,l:{size:1000}})),
    privileges:[{id:11},{id:22}]};
  else if (u.pathname === '/api/song/red/count') d = {code:200,data:{count:u.searchParams.get('songId') === '11' ? 999999 : 1234567}};
  else throw Error('unexpected fixture path');
  return new Response(JSON.stringify(d), {status:200,headers:{'content-type':'application/json'}});
};`)
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    const env = { ...process.env, DATA_PATH: data, LOG_PATH: logs, CONFIG_PATH: configPath,
        PORT: String(port), NODE_ENV: 'production', DISABLE_TELEMETRY: 'true', WEBDAV_ENABLE: 'false',
        NODE_OPTIONS: `--require=${preload}` }
    for (const key of Object.keys(env)) if (/^(LX_USER_|ADMIN_PASSWORD|USER_ENABLE_|WEBPLAYER_PASSWORD)/.test(key)) delete env[key]
    const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js')], { env, stdio: 'ignore' })
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM')
            await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))])
            if (child.exitCode === null) child.kill('SIGKILL')
        }
        fs.rmSync(tmp, { recursive: true, force: true })
    })
    const salt = 'fixture-popular-salt'
    const token = crypto.createHash('md5').update(users[0].password + salt).digest('hex')
    const auth = { u: 'alice', t: token, s: salt, f: 'json', v: '1.16.1', c: 'test' }
    const url = `http://127.0.0.1:${port}/rest/getPopularFavoriteSongs.view`
    const headers = { 'X-Subsonic-User': 'alice', 'X-Subsonic-Token': token, 'X-Subsonic-Salt': salt }
    let ready = false
    for (let i = 0; i < 200; i++) {
        assert.equal(child.exitCode, null)
        try {
            const response = await fetch(url)
            if ((await response.json())['subsonic-response'].error?.code === 40) { ready = true; break }
        } catch { /* wait for startup */ }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(ready)
    let response = await fetch(`${url}?size=1`, { headers })
    let body = (await response.json())['subsonic-response']
    assert.equal(body.status, 'ok')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(body.popularFavoriteSongs.song.length, 1)
    assert.equal(body.popularFavoriteSongs.song[0].id, 'wy_22')
    assert.equal(body.popularFavoriteSongs.song[0].favoriteCount, 1234567)
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(auth) })
    body = (await response.json())['subsonic-response']
    assert.equal(body.status, 'ok')
    assert.equal(body.popularFavoriteSongs.song[0].favoriteSource, 'netease')
    for (const suffix of ['?size=31', '?size=1x', `?u=alice&t=${token}&s=${salt}`]) {
        const result = (await (await fetch(url + suffix, { headers })).json())['subsonic-response']
        assert.equal(result.status, 'failed')
    }
    const invalid = (await (await fetch(url, { headers: { ...headers, 'X-Subsonic-Token': 'wrong' } })).json())['subsonic-response']
    assert.equal(invalid.error.code, 40)
})
