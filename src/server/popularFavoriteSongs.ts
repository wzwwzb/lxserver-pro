import musicDetail from '@/modules/utils/musicSdk/wy/musicDetail.js'

// Both endpoints are public and require neither a user's music-source credentials
// nor a NetEase account. The red-count endpoint returns people who hearted a song.
const ORIGIN = 'https://music.163.com'
const CHART_ID = '6723173524'
const CHART_NAME = '网络热歌榜'
const THRESHOLD = 1_000_000
const MAX_CANDIDATES = 40
const MAX_RESULTS = 30
const CACHE_MS = 6 * 60 * 60 * 1000
const PARTIAL_CACHE_MS = 10 * 60 * 1000
const MAX_STALE_MS = 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 1000
const REQUEST_INTERVAL_MS = 350
const REFRESH_BUDGET_MS = 25_000
const REQUEST_TIMEOUT_MS = 4000

type JsonGetter = (url: string) => Promise<any>
type FavoriteSong = { music: any; favoriteCount: number; favoriteUpdatedAtMs: number }
export type PopularFavoriteSnapshot = {
    source: 'netease'; chartId: string; chartName: string; chartUpdatedAtMs: number | null
    updatedAtMs: number; cacheTtlMs: number; stale: boolean; partial: boolean
    scannedCount: number; candidateCount: number; chartSongCount: number; song: FavoriteSong[]
}

class UpstreamError extends Error {
    constructor(readonly rateLimited = false) { super('Popular songs upstream unavailable') }
}

async function getNetEaseJson(url: string): Promise<any> {
    let response: Response
    try {
        response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${ORIGIN}/`, Origin: ORIGIN },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new UpstreamError(response.status === 429 || response.status === 403)
        return await response.json()
    } catch (error) {
        if (error instanceof UpstreamError) throw error
        throw new UpstreamError()
    }
}

/** Shared cache and single in-flight refresh limit load across users and devices. */
export class PopularFavoriteSongsService {
    private cache: PopularFavoriteSnapshot | null = null
    private inFlight: Promise<PopularFavoriteSnapshot> | null = null
    private retryAfterMs = 0

    constructor(
        private readonly getJson: JsonGetter = getNetEaseJson,
        private readonly now: () => number = Date.now,
        private readonly delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) { }

    async get(): Promise<PopularFavoriteSnapshot> {
        const now = this.now()
        if (this.cache && now - this.cache.updatedAtMs < this.cache.cacheTtlMs) return this.cache
        if (this.inFlight) return this.inFlight
        if (now < this.retryAfterMs) {
            if (this.cache && now - this.cache.updatedAtMs < MAX_STALE_MS) return { ...this.cache, stale: true }
            throw new UpstreamError()
        }
        this.inFlight = this.refresh().then(snapshot => {
            this.cache = snapshot
            this.retryAfterMs = 0
            return snapshot
        }).catch(error => {
            this.retryAfterMs = this.now() + FAILURE_BACKOFF_MS
            if (this.cache && this.now() - this.cache.updatedAtMs < MAX_STALE_MS) return { ...this.cache, stale: true }
            throw error
        }).finally(() => { this.inFlight = null })
        return this.inFlight
    }

    private async refresh(): Promise<PopularFavoriteSnapshot> {
        const startedAt = this.now()
        const chartUrl = new URL('/api/v6/playlist/detail', ORIGIN)
        chartUrl.search = new URLSearchParams({ id: CHART_ID, n: String(MAX_CANDIDATES), s: '0' }).toString()
        const chartResult = await this.getJson(chartUrl.toString())
        const chart = chartResult?.playlist
        if (chartResult?.code !== 200 || !Array.isArray(chart?.trackIds)) throw new UpstreamError()

        const ids = Array.from(new Set<number>(chart.trackIds
            .map((item: any) => item?.id)
            .filter((id: any) => Number.isSafeInteger(id) && id > 0)))
        const candidates = ids.slice(0, MAX_CANDIDATES)
        if (!candidates.length) throw new UpstreamError()
        const detailUrl = new URL('/api/v3/song/detail', ORIGIN)
        detailUrl.search = new URLSearchParams({
            c: JSON.stringify(candidates.map(id => ({ id }))), ids: JSON.stringify(candidates),
        }).toString()
        const details = await this.getJson(detailUrl.toString())
        if (details?.code !== 200 || !Array.isArray(details.songs) || !Array.isArray(details.privileges)) throw new UpstreamError()
        const songsById = new Map<number, any>(details.songs.map((song: any) => [song.id, song]))
        const privilegesById = new Map<number, any>(details.privileges.map((privilege: any) => [privilege.id, privilege]))

        const song: FavoriteSong[] = []
        let scannedCount = 0
        let successfulCount = 0
        let consecutiveFailures = 0
        let partial = false
        for (const id of candidates) {
            if (song.length >= MAX_RESULTS) break
            if (this.now() - startedAt >= REFRESH_BUDGET_MS) { partial = true; break }
            const item = songsById.get(id)
            const privilege = privilegesById.get(id)
            if (!item || !privilege) { partial = true; continue }
            if (scannedCount) await this.delay(REQUEST_INTERVAL_MS)
            if (this.now() - startedAt >= REFRESH_BUDGET_MS) { partial = true; break }
            scannedCount++
            try {
                const countUrl = new URL('/api/song/red/count', ORIGIN)
                countUrl.search = new URLSearchParams({ songId: String(id) }).toString()
                const result = await this.getJson(countUrl.toString())
                const count = result?.data?.count
                if (result?.code !== 200 || !Number.isSafeInteger(count) || count < 0) throw new UpstreamError(result?.code === 429 || result?.code === 403)
                successfulCount++
                consecutiveFailures = 0
                if (count < THRESHOLD) continue
                const music = (musicDetail as any).filterList({ songs: [item], privileges: [privilege] })[0]
                if (!music) { partial = true; continue }
                music.id = `wy_${id}`
                song.push({ music, favoriteCount: count, favoriteUpdatedAtMs: this.now() })
            } catch (error) {
                partial = true
                consecutiveFailures++
                if ((error instanceof UpstreamError && error.rateLimited) || consecutiveFailures >= 3) break
            }
        }
        if (!successfulCount) throw new UpstreamError()
        return {
            source: 'netease', chartId: CHART_ID, chartName: CHART_NAME,
            chartUpdatedAtMs: Number.isSafeInteger(chart.updateTime) && chart.updateTime > 0 ? chart.updateTime : null,
            updatedAtMs: this.now(), cacheTtlMs: partial ? PARTIAL_CACHE_MS : CACHE_MS,
            stale: false, partial, scannedCount, candidateCount: candidates.length,
            chartSongCount: ids.length, song,
        }
    }
}

export const popularFavoriteSongs = new PopularFavoriteSongsService()
