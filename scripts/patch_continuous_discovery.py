from pathlib import Path

# Worker: add Brave Search API as a native lane.
p = Path('apify/native-worker/src/main.js')
s = p.read_text()
a = 'const TRACKING_KEYS = new Set(["gclid", "fbclid", "clickid", "click_id", "aff", "aff_id", "affiliate_id", "subid", "sub_id"]);'
if 'const BRAVE_SEARCH_ENDPOINT' not in s:
    s = s.replace(a, a + '\nconst BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";', 1)
a = '  const runtimeStoreName = String(input.runtimeStoreName ?? "source-scan-native-runtime-v1");'
if 'const braveSearchKey = process.env.BRAVE_SEARCH_API_KEY' not in s:
    s = s.replace(a, a + '\n  const braveSearchKey = process.env.BRAVE_SEARCH_API_KEY ?? "";', 1)
if 'async function processBraveSearch' not in s:
    marker = '  async function processRequest(request) {'
    fn = '''  async function processBraveSearch(request) {\n    if (!braveSearchKey) throw new Error("BRAVE_SEARCH_API_KEY is unavailable in Actor runtime");\n    const query = String(request.userData?.query ?? "").trim();\n    const offset = Math.max(0, Math.min(9, Number(request.userData?.offset ?? 0)));\n    if (!query) return;\n    const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=20&offset=${offset}&safesearch=moderate`;\n    const controller = new AbortController();\n    const t = setTimeout(() => controller.abort(), 15000);\n    try {\n      const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": braveSearchKey, "user-agent": "SourceScanNative/1.0" }, signal: controller.signal });\n      stats.httpRequests += 1;\n      if (res.status === 403) stats.count403 += 1;\n      if (res.status === 429) stats.count429 += 1;\n      if (!res.ok) throw Object.assign(new Error(`Brave HTTP ${res.status}`), { status: res.status });\n      const data = await res.json();\n      const results = data?.web?.results ?? [];\n      for (const item of results) {\n        const u = safeUrl(item?.url);\n        if (!u) continue;\n        const h = u.hostname.replace(/^www\\./, "").toLowerCase();\n        if (NOISE_HOST_RE.test(h) || ASSET_RE.test(u.pathname)) continue;\n        await enqueue("RESOLVE", u.toString(), { discoveredVia: `brave:${query}`, discoveredFrom: request.url, fromRadar: false }, true);\n      }\n      await evidence({ event: "BRAVE_SEARCH", query, offset, results: results.length, moreResultsAvailable: Boolean(data?.query?.more_results_available) });\n    } finally { clearTimeout(t); }\n  }\n\n'''
    s = s.replace(marker, fn + marker, 1)
old = '  async function processRequest(request) {\n    const kind = String(request.userData?.kind ?? "RESOLVE");'
new = '  async function processRequest(request) {\n    const kind = String(request.userData?.kind ?? "RESOLVE");\n    if (kind === "BRAVE_SEARCH") return processBraveSearch(request);'
if old in s and 'if (kind === "BRAVE_SEARCH")' not in s:
    s = s.replace(old, new, 1)
p.write_text(s)

# Orchestrator: broad discovery bootstrap and ongoing 15-minute refill.
p = Path('apify/native-orchestrator/src/main.js')
s = p.read_text()
a = 'const CURATED_SEED_VERSION = "vn-retail-malls-2026-08-15-v1";'
if 'const DISCOVERY_VERSION' not in s:
    block = '''const DISCOVERY_VERSION = "vn-wide-source-discovery-2026-08-15-v1";\nconst DISCOVERY_TERMS = [\n  "trung tâm thương mại", "shopping mall", "siêu thị", "chuỗi bán lẻ", "cửa hàng tiện lợi",\n  "thực phẩm nhập khẩu", "thực phẩm sạch", "mẹ và bé", "điện máy", "điện thoại laptop",\n  "nhà thuốc", "mỹ phẩm làm đẹp", "thời trang", "giày dép", "trang sức", "nội thất gia dụng",\n  "nhà hàng", "cafe trà sữa", "rạp chiếu phim", "khu vui chơi", "khách sạn resort", "hãng bay",\n  "du lịch OTA", "giao đồ ăn", "gọi xe", "ngân hàng thẻ tín dụng", "ví điện tử", "bảo hiểm",\n  "viễn thông internet", "giáo dục", "phòng gym fitness", "spa thẩm mỹ", "ô tô xe máy",\n  "bất động sản", "loyalty membership"\n];\nconst DISCOVERY_MODIFIERS = ["khuyến mãi Việt Nam", "ưu đãi Việt Nam", "voucher Việt Nam", "promotion Vietnam"];\nfunction discoveryQueries() { return DISCOVERY_TERMS.flatMap((term) => DISCOVERY_MODIFIERS.map((m) => `${term} ${m}`)); }\nfunction discoveryWindow() { const slot = Math.floor(Date.now() / (15 * 60_000)); return { bucket: slot, shard: slot % 20, offset: Math.floor(slot / 20) % 10 }; }'''
    s = s.replace(a, a + '\n' + block, 1)
if 'async function seedDiscoveryBootstrap' not in s:
    marker = '  async function seedDaily() {'
    fn = '''  async function seedDiscoveryBootstrap() {\n    const key = `BRAVE_BOOTSTRAP_${DISCOVERY_VERSION}`;\n    const already = await runtimeStore.getValue(key).catch(() => null);\n    if (already) return already;\n    const queries = discoveryQueries();\n    let seeded = 0;\n    for (const query of queries) {\n      const raw = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&offset=0`;\n      await addTask("BRAVE_SEARCH", raw, { query, offset: 0, discoveredVia: "brave_bootstrap" }, `BRAVE:${DISCOVERY_VERSION}:BOOT:`);\n      seeded += 1;\n    }\n    const record = { at: new Date().toISOString(), version: DISCOVERY_VERSION, seeded, offset: 0 };\n    await runtimeStore.setValue(key, record);\n    return record;\n  }\n\n  async function seedDiscoveryWindow() {\n    const { bucket, shard, offset } = discoveryWindow();\n    const key = `BRAVE_WINDOW_${DISCOVERY_VERSION}_${bucket}`;\n    const already = await runtimeStore.getValue(key).catch(() => null);\n    if (already) return already;\n    const queries = discoveryQueries();\n    let seeded = 0;\n    for (let i = 0; i < queries.length; i += 1) {\n      if (i % 20 !== shard) continue;\n      const query = queries[i];\n      const raw = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&offset=${offset}`;\n      await addTask("BRAVE_SEARCH", raw, { query, offset, discoveredVia: "brave_window" }, `BRAVE:${DISCOVERY_VERSION}:${bucket}:`);\n      seeded += 1;\n    }\n    const record = { at: new Date().toISOString(), version: DISCOVERY_VERSION, bucket, shard, offset, seeded };\n    await runtimeStore.setValue(key, record);\n    return record;\n  }\n\n'''
    s = s.replace(marker, fn + marker, 1)
old = '  const bootstrap = await bootstrapOnce();\n  const curated = await seedCuratedIfNeeded();\n  let dailySeeded = 0;'
new = '  const bootstrap = await bootstrapOnce();\n  const curated = await seedCuratedIfNeeded();\n  const braveBootstrap = await seedDiscoveryBootstrap();\n  const braveWindow = await seedDiscoveryWindow();\n  let dailySeeded = 0;'
if old in s and 'const braveBootstrap = await seedDiscoveryBootstrap();' not in s:
    s = s.replace(old, new, 1)
s = s.replace('await publishStatus({ bootstrap, curated, dailySeeded });', 'await publishStatus({ bootstrap, curated, braveBootstrap, braveWindow, dailySeeded });')
p.write_text(s)
