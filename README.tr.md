# claude-openrouter (`cor`)

*[English](README.md)*

Claude Code'a **hiç dokunmadan**, OpenRouter üzerindeki istediğin modelleri `/model` menüsüne ekler.

Arayüz, komutlar, izin sistemi, tool'lar, erişilebilirlik — hepsi aynı kalır. Tek fark, `/model` listesinde artık senin eklediğin modellerin de olması.

```
/model
  Default (Opus 5)
  Sonnet
  Haiku
  ...
  DeepSeek V4 Flash        ← senin ekledigin
  Qwen3 Max                ← senin ekledigin
```

## Nasıl çalışıyor

Claude Code'un kendi **LLM gateway** desteği kullanılıyor. `ANTHROPIC_BASE_URL` ile Claude Code bilgisayarında çalışan küçük bir proxy'ye yönlendiriliyor. Proxy Anthropic Messages API'sini konuşuyor ve isteği modele göre ikiye ayırıyor:

```
Claude Code ──► cor proxy (127.0.0.1)
                    │
   claude-* / sonnet / opus / haiku ──► api.anthropic.com   (aynen iletilir)
   senin ekledigin OpenRouter modeli ──► openrouter.ai      (cevrilir)
```

**Hibrit.** Claude modeli seçtiğinde istek doğrudan Anthropic'e gider — mevcut giriş/aboneliğin aynen çalışır. OpenRouter modeli seçtiğinde istek OpenRouter'a çevrilir.

Claude Code'un Anthropic kimlik bilgisi (OAuth token veya API anahtarı) **asla** OpenRouter'a gönderilmez. Proxy yalnızca `127.0.0.1` dinler.

---

## Kurulum

Gerekenler: **Node.js 20+** ve **Claude Code 2.1.242+** (`modelPicker` ayarı için).

```bash
git clone https://github.com/UmutErayAltay/claude-openrouter.git
cd claude-openrouter
npm install
npm run build
npm link          # 'cor' komutunu PATH'e ekler
```

`npm link` izin hatası verirse `sudo npm link` kullan, ya da link olmadan `node dist/cli/index.js <komut>` şeklinde çalıştır.

Ya da yayınlanmış paketi doğrudan kur:

```bash
npm install -g claude-openrouter
```

## Hızlı başlangıç

```bash
cor key sk-or-v1-...                    # OpenRouter anahtarini kaydet

cor add deepseek/deepseek-v4-flash-0731 \
  --reasoning high \
  --cheapest --quantizations fp8,bf16,fp16 \
  --behaves-as claude-sonnet-5

cor sync                                # /model menusune yansit
cor claude                              # Claude Code'u proxy ile baslat
```

Claude Code açıldığında `/model` → eklediğin model listede. Seç, kullan.

Bu komutun neden böyle olduğu aşağıda tek tek açıklanıyor. Kısaca: `--reasoning high` modelin düşünmesini açar (etkisi çok büyük), `--cheapest` 27 sağlayıcı arasından en ucuzuna yönlendirir, `--quantizations` aşırı sıkıştırılmış ucuz sağlayıcıları eler, `--behaves-as` Claude Code'un "tanımadığım model" uyarısını susturur.

`cor claude`'a verdiğin her argüman `claude`'a aynen geçer:

```bash
cor claude --permission-mode acceptEdits
cor claude -p "testleri calistir"
```

Proxy'yi elle yönetmeyi tercih edersen:

```bash
cor start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Bir şey ters giderse: `cor doctor` her adımı tek tek kontrol eder, `~/.claude-openrouter/proxy.log` ne olduğunu yazar.

---

## Komutlar

| Komut | İş |
|---|---|
| `cor key <anahtar>` | OpenRouter anahtarını kaydet (dosya izni `0600`) |
| `cor add <model-id>` | Model ekle. Etiket, açıklama ve bağlam penceresi katalogdan otomatik çekilir |
| `cor remove <model-id>` | Modeli çıkar |
| `cor list` | Ekli modelleri ve ayarlarını göster |
| `cor search <kelime>` | OpenRouter kataloğunda model ara |
| `cor providers <model-id>` | Modeli sunan sağlayıcıları, fiyatlarını ve kuantizasyonlarını listele |
| `cor sync` | Modelleri `~/.claude/settings.json` içindeki `modelPicker`'a yaz |
| `cor sync --revert` | Son `sync` öncesi haline döndür |
| `cor agent [model-id]` | Tek dosyada çalışan alt ajan oluştur |
| `cor dashboard` | Kullanım/kredi ve model yönetim arayüzünü tarayıcıda aç |
| `cor start` / `stop` / `status` | Proxy'yi yönet |
| `cor claude [...]` | Proxy'yi başlat ve `claude`'u çalıştır |
| `cor doctor` | Kurulumu baştan sona kontrol et |

### `cor add` seçenekleri

| Seçenek | İş |
|---|---|
| `--label <ad>` | `/model` menüsünde görünecek ad |
| `--description <metin>` | Menüde ikinci satır |
| `--context <sayı>` | Gerçek bağlam penceresi (token) |
| `--max-tokens <sayı>` | Çıktı üst sınırı |
| `--reasoning <seviye>` | `none`, `low`, `medium`, `high`, `max` |
| `--cheapest` | Her istekte en ucuz sağlayıcı |
| `--sort <ölçüt>` | `price` (= `--cheapest`), `throughput`, `latency` |
| `--max-price-in <usd>` | Milyon girdi tokeni için sert üst sınır |
| `--max-price-out <usd>` | Milyon çıktı tokeni için sert üst sınır |
| `--quantizations <liste>` | Kabul edilen kuantizasyonlar, virgülle: `fp8,bf16,fp16` |
| `--behaves-as <claude-id>` | Claude Code'un "tanımadığım model" uyarısını susturur |
| `--no-stream` / `--stream` | OpenRouter'a akışsız sor / akışı açık tut |

---

## Reasoning effort — atlanmaması gereken ayar

`--reasoning` modelin düşünme seviyesini belirler ve **etkisi çok büyüktür**. DeepSeek kendi model kartında V4-Flash'i LiveCodeBench'te şöyle gösteriyor:

| Ayar | Skor |
|---|---|
| Düşünme kapalı | %55.2 |
| `high` | %88.4 |
| `max` | %91.6 |

Ayarlamazsan sağlayıcının varsayılanı geçerli olur — yani farkında olmadan en üstteki satırda olabilirsin.

**`high` kullan, `max` kullanma.** Ölçtüğümüz rakamlar:

| Effort | max_tokens | Düşünme token'ı | Toplam çıktı | Sonuç |
|---|---|---|---|---|
| high | 4.000 | 1.376 | 1.672 | ✅ |
| high | 16.000 | 1.749 | 2.265 | ✅ |
| max | 4.000 | 3.999 | 4.000 | ❌ **boş cevap** |
| max | 16.000 | 10.544 | 12.685 | ✅ (aynı cevap) |

`max`, aynı cevap için ~7 kat fazla token yakıyor ve Claude Code'un normal `max_tokens` bütçesinde düşünürken bütçeyi bitirip boş cevap dönüyor.

---

## Sağlayıcı seçimi ve en ucuza yönlendirme

OpenRouter'da aynı modeli birden çok sağlayıcı sunar ve fiyatlar ciddi şekilde ayrışır:

```bash
cor providers deepseek/deepseek-v4-flash-0731
```

```
deepseek/deepseek-v4-flash-0731 - 27 saglayici (ucuzdan pahaliya)

saglayici                 girdi $/M  cikti $/M  kuantizasyon      baglam
Relace                        0.040      0.120           fp4   1.048.576
StreamLake                    0.044      0.132           fp8   1.024.000
Baidu                         0.048      0.144           fp8   1.048.576
DeepInfra                     0.060      0.180           fp8   1.048.576
...
Cloudflare                    0.440      1.320           fp8   1.310.720

En pahali, en ucuzun 11.0 kati.
```

Hep en ucuzu için `--cheapest`. Yedeklemeler açık kalır: en ucuz sağlayıcı kapalıysa sıradaki devreye girer.

**Kuantizasyon sütununa dikkat.** Yukarıda en ucuz sağlayıcı `fp4` sunuyor — 4 bit'e sıkıştırılmış ağırlıklar, kod kalitesini düşürebilir. Bir üstündeki `fp8` sağlayıcı yalnızca %10 daha pahalı:

```bash
cor add <model-id> --cheapest --quantizations fp8,bf16,fp16
```

Canlı doğrulandı: filtresiz `--cheapest` fp4 sunan sağlayıcıya, filtreyle en ucuz fp8 sağlayıcıya gidiyor.

---

## Opus planlasın, ucuz model kodlasın

Pahalı modeli düşünmeye, ucuz modeli yazmaya ayırmak istersen: Claude Code'un alt ajanları (subagent) kendi modellerini kullanabiliyor. `cor agent` bunun için hazır bir tanım yazar.

```bash
cor agent                                          # ekli ilk modeli kullanir
cor agent deepseek/deepseek-v4-flash-0731 --name kodcu
```

`.claude/agents/dosya-kodcu.md` oluşturur:

```yaml
model: deepseek/deepseek-v4-flash-0731
tools: Read, Edit, Write
permissionMode: acceptEdits
maxTurns: 30
```

Kullanımı — ana oturum Opus'ta (veya istediğin Claude modelinde) kalır:

```
> auth akisini nasil duzeltecegimizi planla
  ... Opus planlar, dosyalari gezer, karar verir ...

> bu plani src/auth.ts dosyasina uygula, dosya-kodcu alt ajanini kullan
  ... ucuz model sadece o dosyayi acar ve yazar ...
```

Plan, araştırma ve mimari karar Opus'ta kalır; alt ajan yalnızca verilen planı verilen dosyaya uygular ve ne değiştirdiğini özetler.

**Kısa tool listesi yan fayda değil, asıl mesele.** Metin hâlinde tool çağrısı üreten modeller bunu Claude Code'un 38 tool'luk tam setinde yapıyor; `Read, Edit, Write` ile aynı model canlı testte baştan sona native tool çağrısı üretti.

**Tek dosya sınırı ne kadar sıkı:** alt ajanın elinde Bash, Glob, Grep yok — dosya arayamaz, komut çalıştıramaz. Ama `Write` ile teoride başka bir yola yazabilir; bunu engelleyen şey sistem istemindeki talimat, sert bir kum havuzu değil. Sert sınır istiyorsan alt ajana [PreToolUse hook](https://code.claude.com/docs/en/hooks) ekleyip yol kontrolü yapabilirsin.

---

## Metin hâlinde tool çağrısı kurtarma

Bazı modeller tool çağrısını OpenAI'nin `tool_calls` kanalı yerine **düz metin olarak** yazar:

```
<function=Read>
<parameter=file_path>
/etc/hostname
</parameter>
</function>
```

Claude Code bunu sıradan bir cevap sanır, hiçbir tool çalışmaz, model bozuk görünür. Proxy bunu kendisi çözer:

1. Akış sırasında metnin bir tool çağrısı olduğunu anlar, kalanını Claude Code'a yazmayı bırakır.
2. Ayrıştırıp gerçek bir `tool_use` bloğuna çevirir — parametreler tool şemasındaki tipe göre dönüştürülür (`"50"` → `50`, `"true"` → `true`).
3. O modeli kalıcı olarak akışsız moda alır (`stream: false`), çünkü akışsız yanıtta kurtarma tam yanıt üzerinde yapılabiliyor.

İlk tur dahil hiçbir tur kaybedilmez. Ne olduğunu `~/.claude-openrouter/proxy.log` yazar. Elle kapatmak/açmak için `--no-stream` / `--stream`.

Hem Qwen/Hermes XML biçimi hem `<tool_call>{"name":...,"arguments":{...}}</tool_call>` JSON biçimi tanınır.

---

## Çeviri neyi kapsıyor

Proxy, Anthropic Messages API'si ile OpenAI uyumlu chat-completions arasında çeviri yapar:

- Sistem istemi, metin, görsel (base64 → data URL)
- `tool_use` ↔ `tool_calls`, `tool_result` ↔ `tool` mesajı, hatalı sonuçlar `Error:` önekiyle
- Tool şemaları (`input_schema` → `parameters`) ve `tool_choice`
- Akış (SSE): OpenAI parçaları → `message_start` / `content_block_*` / `message_delta` / `message_stop`
- Parçalı gelen tool argümanları tamponlanır; kesik JSON onarılır, Claude Code'a hiçbir zaman bozuk blok gitmez
- Model düşünürken sessiz kalan akışa 15 saniyede bir `ping` yazılır (Claude Code 300 saniye sessizlikte akışı iptal eder)
- `stop_reason`, token sayıları ve hatalar Anthropic biçimine eşlenir
- Konuşma ortasındaki `system` mesajları `user`'a çevrilir (birçok sağlayıcı ilk sıradan sonraki `system` mesajını reddeder)
- Metin hâlinde gelen tool çağrıları kurtarılır

Temizlenenler: `cache_control`, `thinking` / adaptive reasoning, `effort`, `context_management`. Claude Code tanımadığı bir model ID'sine Anthropic'in tüm özelliklerini gönderdiği için bunların ayıklanması şart; düşünme için yerine OpenRouter'ın kendi `reasoning` parametresi konur.

---

## Dashboard

```bash
cor dashboard
```

Proxy'yi başlatır ve `http://127.0.0.1:<port>/dashboard`'ı açar (tarayıcıyı açmayı dener, başaramazsa URL'yi yine de yazdırır — başlıksız/konteyner ortamlarda beklenen davranış budur). Tek sayfa, dış bağımlılık yok, harici CDN yok:

- **Kalan kredi**: OpenRouter'ın `/key` ucundan canlı — limit, kalan, günlük/haftalık/aylık kullanım. Anahtar geçersiz/eksik/erişilemez olduğunda bunu ayrı ayrı gösterir, dashboard'un geri kalanını etkilemez.
- **Harcama**: son 14 günün grafiği, model bazında dökum, son istekler tablosu — hepsi `~/.claude-openrouter/usage.jsonl`'dan.
- **Model yönetimi**: ekleme, düzenleme (reasoning, sağlayıcı sırası, kuantizasyon, `behaves-as`, akış), silme; katalogda arama-yaz; `cor sync`/`--revert` butonları.
- **Alt ajanlar**: `.claude/agents/` içindeki (proje ve kullanıcı kapsamı) ajanları listeler, hangisinin senin yapılandırdığın bir modeli kullandığını işaretler; yeni ajan oluşturma formu.

Mutasyon uçları (model ekle/sil, ajan yaz) sadece `127.0.0.1`/`localhost`'tan ve dashboard'un kendi origin'inden gelen isteklere açık — açık bıraktığın başka bir sekmenin sessizce buraya yazamaması için.

---

## Dosyalar

| Dosya | İçerik |
|---|---|
| `~/.claude-openrouter/config.json` | Port, model listesi (izin `0600`) — anahtar burada değil |
| `~/.claude-openrouter/key` | OpenRouter API anahtarı, tek başına (izin `0600`) |
| `~/.claude-openrouter/proxy.log` | Proxy günlüğü |
| `~/.claude-openrouter/usage.jsonl` | Dashboard'un okuduğu kullanım kaydı (2MB'ı geçince otomatik kırpılır) |
| `~/.claude/settings.json` | `cor sync` yalnızca `modelPicker` anahtarını yazar |
| `~/.claude/settings.json.cor-bak` | Son `sync` öncesi yedek |

`cor sync` dosyanın geri kalanına dokunmaz; JSON bozuksa hiç yazmaz. `CLAUDE_OPENROUTER_DIR` ve `CLAUDE_CONFIG_DIR` ile dizinleri değiştirebilirsin. Anahtar çözümleme sırası: `OPENROUTER_API_KEY` ortam değişkeni (anahtarı diske hiç yazmak istemiyorsan), sonra `~/.claude-openrouter/key`, sonra — salt okunur, bu dosya var olmadan önce kaydedilmiş bir config için — `config.json` içindeki eski `openrouterApiKey` alanı; `cor key` ve her config kaydı bu alanı otomatik olarak taşır.

---

## Bilinen kısıtlar

- **Anthropic'e özgü özellikler OpenRouter modellerinde çalışmaz:** prompt caching, extended/adaptive thinking, effort seviyeleri, `/fast` modu. Proxy bunları temizler; düşünme için `--reasoning` kullanılır.
- **Bağlam penceresi oturum başında sabitlenir.** `cor claude`, ekli modellerin en küçük bağlam penceresini `CLAUDE_CODE_MAX_CONTEXT_TOKENS` olarak ayarlar. Claude Code bu değeri başlangıçta okur, oturum ortasında model değiştirince güncellenmez.
- **Düşünme (reasoning) çıktısı gösterilmez.** OpenRouter'ın `reasoning` alanı Anthropic imzası taşımadığı için sonraki turda geri gönderilemez; model düşünür, çıktısı aktarılmaz.
- **Tool kalitesi modele bağlıdır.** Claude Code yoğun tool kullanır. Metin hâlinde gelen çağrılar kurtarılır, ama modelin hiç tool çağırmamasına çare yok.
- **`/v1/models` ile otomatik keşif çoğu OpenRouter modeli için işe yaramaz.** Claude Code bu uçtan yalnızca ID'sinde `claude` veya `anthropic` geçen modelleri alır. Asıl yol `cor sync`'in yazdığı `modelPicker` listesidir.
- Claude Code güncellemeleri yeni istek alanları getirebilir. `cor doctor` ve testler bunu erken yakalamak için var.

---

## Geliştirme

```bash
npm test          # 172 birim + uctan uca test
npm run typecheck
npm run build
```

Testler çeviri katmanını (tool gidiş-dönüşü, görseller, `cache_control` temizliği, `stop_reason` eşlemesi, reasoning ve sağlayıcı parametreleri), SSE akışını (parçalı tool argümanları, kesik JSON onarımı, iki eş zamanlı tool çağrısı), metin tool çağrısı kurtarmayı, yönlendirmeyi, ayar dosyası entegrasyonunu ve sahte upstream'lere karşı tüm proxy uçlarını kapsar.

## Lisans

MIT
