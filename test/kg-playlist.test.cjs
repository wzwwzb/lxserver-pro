const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const requests = require('../server/modules/utils/request.js')
const kg = require('../server/modules/utils/musicSdk/kg/songList.js').default

test('Kugou playlist share links resolve collection identifiers from redirects and direct links', async t => {
    const oldFetch = requests.httpFetch
    const oldDetail = kg.getUserListDetail2
    t.after(() => { requests.httpFetch = oldFetch; kg.getUserListDetail2 = oldDetail })
    const received = []
    requests.httpFetch = () => ({ promise: Promise.resolve({
        statusCode: 302, body: '', headers: { location: 'https://activity.kugou.com/share/index.html?global_specialid=collection_3_42_5_0' },
    }) })
    kg.getUserListDetail2 = async id => { received.push(id); return { list: [], total: 0, info: { name: 'fixture' } } }
    await kg.getListDetail('https://t1.kugou.com/example', 1)
    await kg.getListDetail('https://activity.kugou.com/share/index.html?global_specialid=collection_3_42_6_0', 1)
    await kg.getListDetail('https://example.test/share?global_collection_id=collection_3_42_7_0', 1)
    await kg.getListDetail('collection_3_42_8_0', 1)
    assert.deepEqual(received, ['collection_3_42_5_0', 'collection_3_42_6_0', 'collection_3_42_7_0', 'collection_3_42_8_0'])
})

test('a Kugou rate limit stops retries and returns a useful error', async t => {
    const oldFetch = requests.httpFetch
    t.after(() => { requests.httpFetch = oldFetch })
    let calls = 0
    requests.httpFetch = () => {
        calls++
        return { promise: Promise.resolve({ statusCode: 200, body: { errcode: 20028, error: '操作太频繁' } }) }
    }
    await assert.rejects(kg.createHttp('https://example.test/playlist'), error => {
        assert.equal(error.code, 'KG_RATE_LIMITED')
        assert.match(error.message, /酷狗.*请求频率.*稍后/)
        return true
    })
    assert.equal(calls, 1)
})

test('a Kugou security challenge is distinguished from a rate limit', async t => {
    const oldFetch = requests.httpFetch
    t.after(() => { requests.httpFetch = oldFetch })
    let calls = 0
    requests.httpFetch = () => {
        calls++
        return { promise: Promise.resolve({ statusCode: 200, headers: { 'ssa-code': 'fixture-event' }, body: { errcode: 20028, error: '操作太频繁' } }) }
    }
    await assert.rejects(kg.createHttp('https://example.test/playlist'), error => {
        assert.equal(error.code, 'KG_VERIFICATION_REQUIRED')
        assert.match(error.message, /安全验证/)
        return true
    })
    assert.equal(calls, 1)
})

test('playlist pages are fetched in order and stop when the provider rejects a request', async t => {
    const oldCreate = kg.createHttp
    t.after(() => { kg.createHttp = oldCreate })
    let active = 0, peak = 0
    const calls = []
    const expectedSongs = Array.from({ length: 610 }, (_, i) => i)
    kg.createHttp = async url => {
        const query = new URL(url).searchParams
        const page = Number(query.get('page'))
        const pageSize = Number(query.get('pagesize'))
        calls.push([page, pageSize])
        active++; peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return { count: expectedSongs.length, pagesize: pageSize, info: expectedSongs.slice((page - 1) * pageSize, page * pageSize) }
    }
    assert.deepEqual(await kg.createGetListDetail2Task('collection_3_42_5_0', 610), expectedSongs)
    assert.deepEqual(calls, [[1, 300], [2, 300], [3, 300]])
    assert.equal(peak, 1)
    calls.length = 0
    kg.createHttp = async url => { calls.push(url); throw new Error('酷狗限制了请求频率，请稍后再试') }
    await assert.rejects(kg.createGetListDetail2Task('collection_3_42_5_0', 610), /请求频率/)
    assert.equal(calls.length, 1)
})

test('playlist paging honors the provider page size and current count', async t => {
    const oldCreate = kg.createHttp
    t.after(() => { kg.createHttp = oldCreate })
    const expectedSongs = Array.from({ length: 230 }, (_, i) => i)
    const calls = []
    kg.createHttp = async url => {
        const query = new URL(url).searchParams
        const page = Number(query.get('page'))
        const requestedSize = Number(query.get('pagesize'))
        calls.push([page, requestedSize, Number(query.get('type'))])
        const pageSize = Math.min(200, requestedSize)
        return { count: 230, pagesize: pageSize, info: expectedSongs.slice((page - 1) * pageSize, page * pageSize) }
    }
    assert.deepEqual(await kg.createGetListDetail2Task('collection_3_42_5_0', 239, 1), expectedSongs)
    assert.deepEqual(calls, [[1, 300, 1], [2, 200, 1]])
})

test('shared playlist uses the current share-page endpoint end to end', async t => {
    const oldFetch = requests.httpFetch
    const oldMusicInfos = kg.getMusicInfos
    t.after(() => { requests.httpFetch = oldFetch; kg.getMusicInfos = oldMusicInfos })
    const tracks = Array.from({ length: 230 }, (_, i) => ({ hash: `fixture_${i}` }))
    const pageCalls = []
    requests.httpFetch = url => {
        const parsed = new URL(url)
        let response
        if (parsed.hostname === 't1.kugou.com') {
            response = { statusCode: 302, headers: { location: 'https://activity.kugou.com/share/index.html?global_specialid=collection_3_42_5_0' }, body: '' }
        } else if (parsed.pathname === '/api/v5/special/info_v2') {
            response = { statusCode: 200, body: { errcode: 0, data: { songcount: 239, type: 0, specialname: 'fixture', playcount: 0 } } }
        } else if (parsed.hostname === 'pubsongscdn.kugou.com' && parsed.pathname === '/v2/get_other_list_file') {
            pageCalls.push(parsed.searchParams)
            response = { statusCode: 200, body: { error_code: 0, data: { count: 230, pagesize: 300, info: tracks } } }
        } else {
            throw new Error(`unexpected provider path ${parsed.pathname}`)
        }
        return { promise: Promise.resolve(response) }
    }
    kg.getMusicInfos = async items => items.map(item => ({ ...item, source: 'kg' }))
    const result = await kg.getListDetail('https://t1.kugou.com/fixture', 1)
    assert.equal(result.total, 230)
    assert.equal(result.info.unavailableCount, 9)
    assert.deepEqual(result.list.map(song => song.hash), tracks.map(song => song.hash))
    assert.equal(pageCalls.length, 1)
    assert.equal(pageCalls[0].get('global_collection_id'), 'collection_3_42_5_0')
    assert.ok(pageCalls[0].get('signature'))
})

test('large playlists limit concurrent song metadata requests without changing order', async t => {
    const oldCreate = kg.createHttp
    const oldFilter = kg.filterData2
    t.after(() => { kg.createHttp = oldCreate; kg.filterData2 = oldFilter })
    let active = 0, peak = 0
    kg.createHttp = async (url, options) => {
        active++; peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return options.body.data.map(item => [{ hash: item.hash }])
    }
    kg.filterData2 = songs => songs
    const input = Array.from({ length: 450 }, (_, i) => ({ hash: `hash_${i}` }))
    assert.deepEqual(await kg.getMusicInfos(input), input)
    assert.equal(peak, 2)
})

function playlistView(fetch, timer = setTimeout) {
    const ids = ['songlist-detail-view', 'sl-detail-list', 'sl-detail-name', 'sl-detail-title', 'sl-detail-subtitle', 'sl-detail-desc', 'sl-detail-stats']
    const elements = new Map(ids.map(id => [id, {
        id, classList: { add() {}, remove() {}, contains() { return true } }, style: {},
        innerHTML: '', innerText: '', textContent: '', children: [], dataset: {}, scrollTo() {},
        addEventListener() {}, removeEventListener() {}, replaceChildren(...children) { this.children = children; this.innerHTML = '' },
    }]))
    const document = {
        getElementById: id => elements.get(id) || null,
        createElement: () => ({ className: '', textContent: '' }),
    }
    const window = {
        ListSearch: {
            resetState() {}, init() {},
            getDisplayList: list => list.map((item, originalIndex) => ({ item, originalIndex })),
            isMatched: () => false, isCurrentMatch: () => false,
        },
        selectedItems: new Set(), setImg() {},
    }
    const context = { window, document, localStorage: { getItem: () => null },
        fetch, setTimeout: timer, clearTimeout, AbortController, console: { error() {}, log() {}, warn() {} } }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/music/js/songlist_manager.js'), 'utf8'), context)
    window.SongListManager.openDetail('fixture', 'kg')
    elements.window = window
    return elements
}

test('a loaded playlist renders its songs in the web player', async () => {
    const tracks = Array.from({ length: 230 }, (_, i) => ({ songmid: `track_${i}`, name: `Song ${i}`, singer: 'Singer', source: 'kg' }))
    const elements = playlistView(async () => ({ ok: true, status: 200, json: async () => ({ list: tracks, total: tracks.length, info: { name: 'fixture', unavailableCount: 9 } }) }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(elements.window.viewingPlaylist.length, 230)
    assert.match(elements.get('sl-detail-list').innerHTML, /id="sl-row-229"/)
    assert.match(elements.get('sl-detail-stats').innerHTML, /另有 9 首未返回/)
})

test('playlist error response replaces the loading indicator with a safe message', async () => {
    const elements = playlistView(async () => ({ ok: false, status: 500, json: async () => ({ error: '酷狗限制了请求频率，请稍后再试' }) }))
    await new Promise(resolve => setTimeout(resolve, 30))
    const list = elements.get('sl-detail-list')
    assert.equal(list.children.length, 1)
    assert.match(list.children[0].textContent, /加载失败：酷狗限制了请求频率/)
    assert.equal(elements.get('sl-detail-name').textContent, '加载失败')
    assert.equal(elements.get('sl-detail-subtitle').textContent, '酷狗限制了请求频率，请稍后再试')
})

test('a stalled playlist response body times out and removes the loading indicator', async () => {
    const elements = playlistView(async (url, { signal }) => ({
        ok: true, status: 200,
        json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            const error = new Error('aborted'); error.name = 'AbortError'; reject(error)
        })),
    }), (callback, delay) => setTimeout(callback, delay === 30000 ? 10 : delay))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.match(elements.get('sl-detail-list').children[0].textContent, /请求超时，请稍后再试/)
    assert.equal(elements.get('sl-detail-name').textContent, '加载失败')
})
