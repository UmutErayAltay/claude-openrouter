---
name: cor-dashboard-tasarim
description: cor'un web dashboard'unda (src/server/dashboardPage.ts, dashboardStyles.ts, dashboardScript.ts) HERHANGİ bir görsel/arayüz değişikliği yapmadan önce kullan — yeni bir kart, grafik, buton, tablo, renk, boşluk. "dashboard'u güzelleştir", "yeni bir grafik ekle", "arayüzü geliştir" dendiğinde veya bunny-frontend/bunny-coder bu üç dosyaya dokunacaksa proaktif kullan.
---

# cor Dashboard Tasarımı

cor'un tek-sayfa dashboard'u (`/dashboard`) için proje-özel tasarım rehberi.
Üç dosya birlikte çalışır: `dashboardPage.ts` (HTML iskeleti),
`dashboardStyles.ts` (`DASHBOARD_CSS`), `dashboardScript.ts` (`DASHBOARD_JS`).
Bu rehber, Claude'un `dataviz` ve `artifact-design` skillerinin bu sayfaya
uyarlanmış, validator'dan geçirilmiş hâlidir — burada yazan değerler
tahmin değil, ölçülmüş.

## Kimlik: "araç paneli", SaaS vitrini değil

cor bir geliştirici aracı: CLI + yerel proxy. Dashboard bir **ops konsolu**
gibi okunmalı — yoğun, tarama için tasarlanmış, rakamlar ön planda,
terminal diline yakın. Şu klişelerden UZAK dur (bunlar "AI yapmış"
görünümünün ta kendisi): tek bir parlak vurgu rengiyle simsiyah zemin,
her şeyi yuvarlatan `border-radius`, kartlarda vurgu çubuğu/şeridi,
gradient hero, emoji başlık işaretleri, ortalanmış her şey, her kutuya
aynı gölge. Sayfa **sol hizalı**, gölgesiz, hairline kenarlıklı ve sıkı
bir ızgara üzerinde durur.

## Kırmızı çizgi: sıfır bağımlılık

`dashboardPage.ts`'in kendi yorumu: "no CDN, no build step". cor sıfır
runtime dependency ile yayınlanıyor. Yani:

- **Hiçbir CDN, npm paketi, web font.** Grafikler ham `<svg>`/`<div>` +
  CSS/JS. Sistem fontu: `--sans` etiketler için, `--mono` rakamlar için.
- Yeni CSS/JS ilgili `DASHBOARD_CSS`/`DASHBOARD_JS` string'inin İÇİNE
  gider; ayrı dosya açılmaz.
- `dashboardScript.ts` içine backtick veya `${...}` KOYMA — o dosya
  `dashboardPage.ts`'in template literal'i içine gömülüyor.

## Renk sistemi — tek kaynak `:root`, ham hex yasak

Tüm renkler `dashboardStyles.ts` `:root` değişkenleridir. Aşağıdaki set,
`dataviz` validator'ından koyu yüzeye (`#191f26`) karşı **tüm çiftler**
modunda geçirildi (lightness bandı, chroma tabanı, CVD ayrımı, normal
görüş tabanı, ≥3:1 kontrast — hepsi PASS). Değiştirmeden önce tekrar
validator'dan geçir.

Zemin ve metin (mavi eğilimli mürekkep + sıcak kağıt — nötrler bilinçli,
saf gri değil):
```
--bg:        #12161b   /* sayfa zemini */
--bg-elev:   #191f26   /* kart yüzeyi — grafiklerin ölçüldüğü yüzey */
--bg-elev-2: #20272f   /* iç yüzey: input, hover satırı */
--border:    #2b333d   /* hairline, 1px, solid */
--text:      #e8e4d9   /* birincil metin */
--text-dim:  #a3a8ad
--text-faint:#6d747b
```
Vurgu (eylem/odak — tek kullanım yeri butonlar, aktif durum, bağlantı):
```
--accent:     #d4a656   /* pirinç; soğuk zemine sıcak karşıtlık */
--accent-dim: #a8843f
--accent-bg:  rgba(212,166,86,0.12)
```
Veri işaretleri (tek seri; model adları NOMİNAL kategori → her çubuk
AYNI renk, ayrım etiketle):
```
--series-1:   #4d78c4   /* çelik mavi — vurgu rengi DEĞİL, karışmaz */
```
Durum (yalnızca bir şeyin iyi/kötü OLDUĞU yerde; asla "2. seri" olarak):
```
--success:    #45a888   /* iyi   — ok istekler */
--danger:     #c0403a   /* kritik — hata istekler */
--warning:    #c9931f   /* uyarı — SADECE kredi göstergesinin orta hâli;
                           bir grafikte --danger'ın yanına koyma (CVD'de
                           ayrışmıyor, ölçüldü) */
```
Kural: **metin asla seri rengini giymez.** Rakamlar/etiketler `--text*`
tonlarında; kimliği yanındaki renkli işaret (nokta, çubuk) taşır.

## Tipografi ve biçim

- Etiketler `--sans`; **tüm rakamlar, model kimlikleri, zaman damgaları
  `--mono`** ve tablolarda/eksende `font-variant-numeric: tabular-nums`.
  Büyük tekil rakamlar (stat tile) `tabular-nums` KULLANMAZ (orantılı).
- Bölüm başlığı: küçük, büyük harf, `letter-spacing: .06em`, `--text-dim`
  — "eyebrow". Kart başlığı olarak devasa `<h2>` yok.
- `--radius: 4px`. Sadece kart ve input köşelerinde; çubuklar, rozetler,
  tablolar köşesiz veya 2px.
- Gölge yok. Kart = `--bg-elev` + 1px `--border`. Hover satırı = `--bg-elev-2`.

## Grafik kuralları (dataviz'den, bu sayfaya)

- **Önce özet, sonra detay:** sayfa stat tile satırıyla açılır (bugünkü
  harcama, bugünkü istek, başarı oranı, ekli model). Stat tile = etiket
  (küçük, iki nokta yok) + değer (sans semibold, kompakt: 1.2K / $4.20) +
  isteğe bağlı delta.
- **Tek eksen.** Asla çift y-ekseni. İki ölçü → iki grafik.
- Çubuk ≤ 24px kalın, tabandan büyür, **veri ucunda 4px yuvarlama,
  tabanda köşeli**; bitişik çubuk/segment arası **2px yüzey boşluğu**
  (kenarlık ÇİZME).
- Gridline/eksen: 1px solid, yüzeyden bir ton açık, kesikli DEĞİL.
- Her işaretin hover'da `.chart-tip` açıklaması var; ama tooltip tek okuma
  yolu değil — değer tabloda/etikette de var.
- ≥2 seri → legend zorunlu; tek seri → legend yok (başlık zaten söylüyor).
- Renk tek başına anlam taşımaz: ok/hata segmentleri legend + rakamla.
- Boş veri: `0/0`, `NaN%`, boş çubuk YAZDIRMA — mevcut `empty-row`/boş
  durum deseniyle "henüz istek yok".
- Yenilemede skeleton flaş yok: önceki çizimi düşük opaklıkta tut.
- Sayı biçimi: mevcut `fmtMoney`/`fmtNum`/`fmtDate` yardımcıları.

## Zaten var olan bileşenler — icat etme, genişlet

`.card`, `.btn/.btn-secondary/.btn-danger/.btn-small`, `.badge`,
tablo + `setRows()` (boş durum dahil), `.chart-bar/.chart-tip`,
`.credit-bar`, `.toast`. Yeni bir tablo `setRows()` kullanır; yeni bir
geri bildirim `.toast` kullanır.

## Bitirmeden önce

1. `npm run typecheck && npm test` — yeni API alanı eklediysen
   `test/dashboardApi.test.ts` / `test/dashboardPage.test.ts` güncel mi?
2. Sayfayı GERÇEKTEN aç (`cor start` → `http://127.0.0.1:8787/dashboard`)
   ve bir kez bak: etiket çakışması, taşma, dar ekran (`main` `max-width:
   980px`, sabit `width` yok).
3. Boş veri durumunu gerçekten tetikle.
4. Konsol hatası yok (`node --check` en az).
