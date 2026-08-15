from pathlib import Path

p = Path('apify/native-orchestrator/src/main.js')
s = p.read_text()

start = s.index('const DEFAULT_SEEDS = [')
end = s.index('];', start) + 2
block = '''const CURATED_SEED_VERSION = "vn-retail-malls-2026-08-15-v1";
const DEFAULT_SEEDS = [
  // Radar / marketplaces / platforms
  "https://bloggiamgia.vn/",
  "https://www.picodi.com/vn/",
  "https://shopee.vn/",
  "https://www.lazada.vn/",
  "https://tiki.vn/",
  "https://www.grab.com/vn/",
  "https://www.traveloka.com/vi-vn/",

  // Banks / issuers
  "https://www.vietcombank.com.vn/",
  "https://techcombank.com/",
  "https://www.vpbank.com.vn/",
  "https://www.acb.com.vn/",
  "https://www.sacombank.com.vn/",
  "https://www.mbbank.com.vn/",
  "https://www.vib.com.vn/",
  "https://www.hdbank.com.vn/",
  "https://www.ocb.com.vn/",

  // Shopping malls / retail property
  "https://vincom.com.vn/",
  "https://www.aeon.com.vn/",
  "https://aeonmall-binhtan.com.vn/",
  "https://aeonmall-hadong.com.vn/",
  "https://aeonmall-haiphong-lechan.com.vn/",
  "https://aeonmall-tanphuceladon.com.vn/",
  "https://lottemallwestlakehanoi.vn/",
  "https://www.thisomallsala.vn/vn",
  "https://shopping.saigoncentre.com.vn/",
  "https://www.crescentmall.com.vn/",
  "https://gigamall.com.vn/",
  "https://centralretail.com.vn/",

  // Supermarket / grocery / food retail
  "https://homefarm.vn/",
  "https://www.winmart.vn/",
  "https://co-opmart.com.vn/",
  "https://mmvietnam.com/",
  "https://emart.com.vn/",

  // Electronics / technology
  "https://www.thegioididong.com/",
  "https://www.dienmayxanh.com/",
  "https://fptshop.com.vn/",
  "https://cellphones.com.vn/",
  "https://viettelstore.vn/",

  // Pharmacy / beauty
  "https://nhathuoclongchau.com.vn/",
  "https://www.pharmacity.vn/",
  "https://www.guardian.com.vn/",
  "https://www.watsons.vn/",

  // Jewellery / fashion / lifestyle
  "https://www.pnj.com.vn/",
  "https://www.uniqlo.com/vn/",
  "https://www.decathlon.vn/",
  "https://www.canifa.com/",
  "https://juno.vn/",

  // F&B / entertainment
  "https://www.highlandscoffee.com.vn/",
  "https://phuclong.com.vn/",
  "https://kfcvietnam.com.vn/",
  "https://lotteria.vn/",
  "https://jollibee.com.vn/",
  "https://www.cgv.vn/",
  "https://www.galaxycine.vn/"
];'''
s = s[:start] + block + s[end:]

old = '''    for (const url of seedUrls) await seedRoot(url, /bloggiamgia|picodi|giamgia|coupon|voucher/i.test(url), "curated_seed");
    const record = { at: new Date().toISOString(), importedSources, importedCandidates, curatedSeeds: seedUrls.length };
    await runtimeStore.setValue("BOOTSTRAPPED", record);
    return record;
  }

  async function seedDaily() {'''
new = '''    const record = { at: new Date().toISOString(), importedSources, importedCandidates };
    await runtimeStore.setValue("BOOTSTRAPPED", record);
    return record;
  }

  async function seedCuratedIfNeeded() {
    const key = `CURATED_SEEDS_${CURATED_SEED_VERSION}`;
    const already = await runtimeStore.getValue(key).catch(() => null);
    if (already) return already;
    let seededRoots = 0;
    const prefix = `CURATED:${CURATED_SEED_VERSION}:`;
    for (const url of seedUrls) {
      await seedRoot(url, /bloggiamgia|picodi|giamgia|coupon|voucher/i.test(url), "curated_seed", prefix);
      seededRoots += 1;
    }
    const record = { at: new Date().toISOString(), version: CURATED_SEED_VERSION, seededRoots };
    await runtimeStore.setValue(key, record);
    return record;
  }

  async function seedDaily() {'''
if old not in s:
    raise SystemExit('bootstrap seed patch target not found')
s = s.replace(old, new, 1)

old2 = '''  const bootstrap = await bootstrapOnce();
  let dailySeeded = 0;'''
new2 = '''  const bootstrap = await bootstrapOnce();
  const curated = await seedCuratedIfNeeded();
  let dailySeeded = 0;'''
if old2 not in s:
    raise SystemExit('curated call patch target not found')
s = s.replace(old2, new2, 1)

old3 = '''  await publishStatus({ bootstrap, dailySeeded });'''
new3 = '''  await publishStatus({ bootstrap, curated, dailySeeded });'''
if old3 not in s:
    raise SystemExit('status patch target not found')
s = s.replace(old3, new3, 1)

p.write_text(s)
