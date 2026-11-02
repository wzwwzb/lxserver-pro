const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { once } = require('node:events')
const { test } = require('node:test')

global.lx = { config: { 'proxy.all.enabled': false, 'system.allowUnsafeVM': false, 'debug.enabled': false } }
const { loadUserApi } = require('../../server/server/userApi.js')
let sequence = 0
async function load(script) {
    const result = await loadUserApi({
        id: `compat-${++sequence}`, name: 'compat-fixture', owner: 'temp', enabled: false,
        description: '', version: 'test', author: '', homepage: '', sources: {},
        script: `const {utils, request, on, send, EVENT_NAMES} = lx;
            send(EVENT_NAMES.inited, {sources: {wy: {type:'music', actions:['musicUrl'], qualitys:['128k']}}});
            ${script}`,
    })
    assert.equal(result.success, true, result.error)
    return {
        async callRequest(...args) {
            try { return await result.apiInstance.callRequest(...args) }
            catch (error) { throw new Error(String(error?.message || error)) }
        },
    }
}

test('LX script encryption matches the desktop API', async t => {
    const key = '0123456789abcdef'
    const data = 'LX crypto compatibility 测试'
    for (const mode of ['aes-128-cbc', 'aes-128-ecb', 'cbc']) {
        await t.test(mode, async () => {
            const fullMode = mode === 'cbc' ? 'aes-128-cbc' : mode
            const iv = mode.endsWith('ecb') ? '' : key
            const cipher = crypto.createCipheriv(fullMode, key, iv)
            const expected = Buffer.concat([cipher.update(data), cipher.final()]).toString('hex')
            const api = await load(`on(EVENT_NAMES.request, () => Promise.resolve(
                utils.crypto.aesEncrypt(utils.buffer.from(${JSON.stringify(data)}), ${JSON.stringify(mode)},
                    utils.buffer.from(${JSON.stringify(key)}), ${JSON.stringify(iv)}).toString('hex')));`)
            assert.equal(await api.callRequest('musicUrl', 'wy', {}), expected)
        })
    }
    await t.test('RSA uses the desktop API padding and leading zeros', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
        const pem = publicKey.export({ type: 'spki', format: 'pem' })
        const api = await load(`on(EVENT_NAMES.request, () => Promise.resolve(
            utils.crypto.rsaEncrypt(utils.buffer.from('fixture'), ${JSON.stringify(pem)}).toString('hex')));`)
        const encrypted = Buffer.from(await api.callRequest('musicUrl', 'wy', {}), 'hex')
        const decrypted = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, encrypted)
        assert.deepEqual(decrypted, Buffer.concat([Buffer.alloc(121), Buffer.from('fixture')]))
    })
})

test('LX request preserves desktop response semantics and useful upstream errors', async t => {
    const payload = JSON.stringify({ code: 0, url: 'https://audio.example/fixture.mp3', title: '中文' })
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/octet') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
            res.end(payload)
        } else if (url.pathname === '/plain') {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end('plain text 中文')
        } else if (url.pathname === '/suspended') {
            res.writeHead(503, { 'Content-Type': 'text/html' })
            res.end('<title>Service Suspended</title>')
        } else {
            setTimeout(() => { res.writeHead(200); res.end('ok') }, 20)
        }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    const base = `http://127.0.0.1:${server.address().port}`
    const requestHelper = `const fetchResponse = path => new Promise((resolve, reject) => {
        request(${JSON.stringify(base)} + path, {method:'GET'}, (error, response, body) => {
            if (error) reject(error); else resolve({response, body});
        });
    });`
    await t.test('JSON with a binary Content-Type is parsed and raw bytes remain available', async () => {
        const api = await load(`${requestHelper}
            on(EVENT_NAMES.request, async () => {
                const {response, body} = await fetchResponse('/octet');
                return {code: body.code, url: response.body.url,
                    raw: utils.buffer.bufToString(response.raw, 'utf8'), bytes: response.bytes};
            });`)
        const result = await api.callRequest('musicUrl', 'wy', {})
        assert.equal(result.code, 0)
        assert.equal(result.url, 'https://audio.example/fixture.mp3')
        assert.equal(result.raw, payload)
        assert.equal(result.bytes, Buffer.byteLength(payload))
    })
    await t.test('non-JSON text is returned as text', async () => {
        const api = await load(`${requestHelper}
            on(EVENT_NAMES.request, async () => (await fetchResponse('/plain')).body);`)
        assert.equal(await api.callRequest('musicUrl', 'wy', {}), 'plain text 中文')
    })
    await t.test('upstream HTTP errors identify the host and status without exposing URL keys', async () => {
        const api = await load(`${requestHelper}
            on(EVENT_NAMES.request, async () => {
                await fetchResponse('/suspended?token=private-fixture-value');
                throw new Error('unknow error');
            });`)
        await assert.rejects(api.callRequest('musicUrl', 'wy', {}), error => {
            assert.match(error.message, /unknow error/)
            assert.match(error.message, /127\.0\.0\.1.*HTTP 503/)
            assert.ok(!error.message.includes('private-fixture-value'))
            return true
        })
    })
    await t.test('concurrent calls keep their own HTTP diagnostics', async () => {
        const api = await load(`${requestHelper}
            on(EVENT_NAMES.request, async ({info}) => {
                await fetchResponse(info.path);
                await new Promise(resolve => setTimeout(resolve, info.delay));
                throw new Error('fixture failure');
            });`)
        const [suspended, normal] = await Promise.allSettled([
            api.callRequest('musicUrl', 'wy', {path:'/suspended', delay:60}),
            api.callRequest('musicUrl', 'wy', {path:'/normal', delay:0}),
        ])
        assert.equal(suspended.status, 'rejected')
        assert.match(suspended.reason.message, /HTTP 503/)
        assert.equal(normal.status, 'rejected')
        assert.equal(normal.reason.message, 'fixture failure')
    })
    await t.test('event registration and init return Promises', async () => {
        const api = await load(`on(EVENT_NAMES.request, () => Promise.resolve('ok')).then(() => {
            return send(EVENT_NAMES.inited, {sources:{wy:{actions:['musicUrl'],qualitys:['128k']}}});
        }).then(() => {});`)
        assert.equal(await api.callRequest('musicUrl', 'wy', {}), 'ok')
    })
})
