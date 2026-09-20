# claude-openrouter

Claude Code'a **hiç dokunmadan**, OpenRouter üzerindeki istediğin modelleri `/model` menüsüne ekler.

Arayüz, komutlar, izin sistemi, tool'lar, erişilebilirlik — hepsi aynı kalır. Tek fark, `/model` listesinde artık senin eklediğin modellerin de olması.

```
/model
  Default (Opus 5)
  Sonnet
  Haiku
  ...
  GPT-5 (OpenRouter)        ← senin ekledigin
  Qwen3 Max (OpenRouter)    ← senin ekledigin
```

## Nasıl çalışıyor

Claude Code'un kendi **LLM gateway** desteğini kullanıyoruz. `ANTHROPIC_BASE_URL` ile Claude Code'u bilgisayarında çalışan küçük bir proxy'ye yönlendiriyoruz. Proxy, Anthropic Messages API'sini konuşuyor ve isteği modele göre ikiye ayırıyor:

```
Claude Code ──► cor proxy (127.0.0.1)
                    │
   claude-* / sonnet / opus / haiku ──► api.anthropic.com   (aynen iletilir)
   senin ekledigin OpenRouter modeli ──► openrouter.ai      (cevrilir)
```

**Hibrit.** Claude modeli seçtiğinde istek doğrudan Anthropic'e gider — mevcut giriş/aboneliğin aynen çalışır. OpenRouter modeli seçtiğinde istek OpenRouter'a çevrilir.

Claude Code'un Anthropic kimlik bilgisi (OAuth token veya API anahtarı) **asla** OpenRouter'a gönderilmez. Proxy sadece `127.0.0.1` dinler.

## Kurulum

Node.js 20+ ve Claude Code 2.1.242+ gerekir (`modelPicker` ayarı için).

```bash
git clone https://github.com/UmutErayAltay/Claude-code-ve-di-er-modeller.git
cd Claude-code-ve-di-er-modeller
npm install
npm run build
npm link          # 'cor' komutunu PATH'e ekler
```

## Hızlı başlangıç

```bash
cor key sk-or-v1-...                 # OpenRouter anahtarini kaydet
cor search gpt                       # dogru model ID'sini bul
cor add openai/gpt-5                 # modeli ekle
cor sync                             # /model menusune yansit
cor claude                           # Claude Code'u proxy ile baslat
```

Sonra Claude Code içinde `/model` → eklediğin model listede.

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

## Komutlar

| Komut | İş |
|---|---|
| `cor key <anahtar>` | OpenRouter anahtarını kaydet (dosya izni `0600`) |
| `cor add <model-id>` | Model ekle. Etiket, açıklama ve bağlam penceresi OpenRouter kataloğundan otomatik çekilir |
| `cor remove <model-id>` | Modeli çıkar |
| `cor list` | Ekli modelleri göster |
| `cor search <kelime>` | OpenRouter kataloğunda ara |
| `cor sync` | Modelleri `~/.claude/settings.json` içindeki `modelPicker`'a yaz |
| `cor sync --revert` | Son `sync` öncesi haline döndür |
| `cor start` / `stop` / `status` | Proxy'yi yönet |
| `cor claude [...]` | Proxy'yi başlat ve `claude`'u çalıştır |
| `cor doctor` | Kurulumu baştan sona kontrol et |

### `cor add` seçenekleri

```bash
cor add openai/gpt-5 \
  --label "GPT-5" \
  --description "Gunluk is icin" \
  --context 400000 \
  --max-tokens 64000 \
  --behaves-as claude-sonnet-5
```

`--behaves-as` isteğe bağlıdır: Claude Code'un "bu model bu sürümün model kataloğunda yok" uyarısını susturur. Verdiğin Claude modelinin yeteneklerini varsayar; proxy Anthropic'e özgü alanları zaten temizlediği için istek bozulmaz.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `~/.claude-openrouter/config.json` | Anahtar, port, model listesi (izin `0600`) |
| `~/.claude-openrouter/proxy.log` | Proxy günlüğü |
| `~/.claude/settings.json` | `cor sync` sadece `modelPicker` anahtarını yazar |
| `~/.claude/settings.json.cor-bak` | Son `sync` öncesi yedek |

`cor sync` dosyanın geri kalanına dokunmaz; JSON bozuksa hiç yazmaz. `CLAUDE_OPENROUTER_DIR` ve `CLAUDE_CONFIG_DIR` ile dizinleri değiştirebilirsin. `OPENROUTER_API_KEY` ortam değişkeni, kayıtlı anahtarın önüne geçer — anahtarı diske hiç yazmak istemiyorsan.

## Çeviri neyi kapsıyor

Proxy Anthropic Messages API'si ile OpenAI uyumlu chat-completions arasında çeviri yapar:

- Sistem istemi, metin, görsel (base64 → data URL)
- `tool_use` ↔ `tool_calls`, `tool_result` ↔ `tool` mesajı, hatalı sonuçlar `Error:` önekiyle
- Tool şemaları (`input_schema` → `parameters`) ve `tool_choice`
- Akış (SSE): OpenAI parçaları → `message_start` / `content_block_*` / `message_delta` / `message_stop`
- Parçalı gelen tool argümanları tamponlanır; kesik JSON onarılır, böylece Claude Code'a hiçbir zaman bozuk blok gitmez
- Model düşünürken sessiz kalan akışa 15 saniyede bir `ping` yazılır (Claude Code 300 saniye sessizlikte akışı iptal eder)
- `stop_reason`, kullanım (token) sayıları ve hatalar Anthropic biçimine eşlenir
- Konuşma ortasındaki `system` mesajları `user`'a çevrilir (birçok sağlayıcı ilk sıradan sonra gelen `system` mesajını reddeder)

Temizlenenler: `cache_control`, `thinking` / adaptive reasoning, `effort`, `context_management`. Claude Code tanımadığı bir model ID'sine Anthropic'in tüm özelliklerini gönderdiği için bunların ayıklanması şart.

## Bilinen kısıtlar

- **Anthropic'e özgü özellikler OpenRouter modellerinde çalışmaz:** prompt caching, extended/adaptive thinking, effort seviyeleri, `/fast` modu. Proxy bunları sessizce temizler.
- **Bağlam penceresi oturum başında sabitlenir.** `cor claude`, ekli modellerin en küçük bağlam penceresini `CLAUDE_CODE_MAX_CONTEXT_TOKENS` olarak ayarlar. Claude Code bu değeri başlangıçta okur, oturum ortasında model değiştirince güncellenmez.
- **Düşünme (reasoning) çıktısı atılır.** OpenRouter'ın `reasoning` alanı Anthropic imzası taşımadığı için sonraki turda geri gönderilemez; bu yüzden aktarılmaz.
- **Tool kalitesi modele bağlıdır.** Claude Code yoğun tool kullanır; tool-calling desteği zayıf modeller iyi sonuç vermez.
- **`/v1/models` ile otomatik keşif çoğu OpenRouter modeli için işe yaramaz.** Claude Code bu uçtan sadece ID'sinde `claude` veya `anthropic` geçen modelleri alır. Bu yüzden asıl yol `cor sync`'in yazdığı `modelPicker` listesidir.
- Claude Code güncellemeleri yeni istek alanları getirebilir. `cor doctor` ve testler bunu erken yakalamak için var.

## Geliştirme

```bash
npm test          # 67 birim + uctan uca test
npm run typecheck
npm run build
```

Testler çeviri katmanını (tool gidiş-dönüşü, görseller, `cache_control` temizliği, `stop_reason` eşlemesi), SSE akışını (parçalı tool argümanları, kesik JSON onarımı, iki eşzamanlı tool çağrısı), yönlendirmeyi, ayar dosyası entegrasyonunu ve sahte upstream'lere karşı tüm proxy uçlarını kapsar.

## Lisans

MIT
