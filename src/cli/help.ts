export const HELP = `claude-openrouter (cor) - Claude Code'a OpenRouter modelleri ekler

Kullanim: cor <komut> [secenekler]

Kurulum
  key <anahtar>            OpenRouter API anahtarini kaydet (dosya izni 0600)
  add <model-id>           Modeli listeye ekle. Ornek: cor add openai/gpt-5
      --label <ad>           /model menusunde gorunecek ad
      --description <metin>  menude ikinci satir
      --context <sayi>       gercek baglam penceresi (token)
      --max-tokens <sayi>    cikti ust siniri
      --behaves-as <claude-id>  Claude Code'un "tanimadigi model" uyarisini susturur
                                (ornek: --behaves-as claude-sonnet-5)
      --no-stream            OpenRouter'a akissiz sor. Bazi modeller akis modunda
                             tool cagrisini duz metin yaziyor; proxy bunu kendisi
                             de fark edip kalici olarak kapatir
      --stream               akisi acik tut
      --reasoning <seviye>   OpenRouter reasoning effort: none, low, medium, high, max.
                             Ayarlanmazsa saglayicinin varsayilani gecerli olur;
                             fark buyuk olabilir
      --cheapest             Her istekte en ucuz saglayiciyi sec
      --sort <olcut>         price (= --cheapest), throughput veya latency
      --max-price-in <usd>   Milyon girdi tokeni icin ust sinir
      --max-price-out <usd>  Milyon cikti tokeni icin ust sinir
      --quantizations <liste>  Kabul edilen kuantizasyonlar, virgulle (ornek: fp8,bf16)
  remove <model-id>        Modeli listeden cikar
  list                     Ekli modelleri goster
  search <kelime>          OpenRouter katalogunda model ara
  providers <model-id>     Modeli sunan saglayicilari ve fiyatlarini listele

Claude Code ile birlestirme
  sync                     Modelleri ~/.claude/settings.json icindeki modelPicker'a yaz
  sync --revert            Son sync oncesi haline dondur
  claude [...]             Proxy'yi baslat ve claude'u ayni argumanlarla calistir
  agent [model-id]         Tek dosyada calisan alt ajan olustur (Opus planlar, bu model kodlar)
      --name <ad>            alt ajanin adi (varsayilan: dosya-kodcu)
      --scope project|user   .claude/agents (varsayilan) ya da ~/.claude/agents

Proxy
  start                    Proxy'yi arka planda baslat
  stop                     Proxy'yi durdur
  status                   Durumu goster
  doctor                   Kurulumu bastan sona kontrol et
  dashboard                Proxy'yi baslat, kullanim/kredi ve model yonetim
                           arayuzunu tarayicida ac (http://127.0.0.1:<port>/dashboard)

Ortam degiskenleri
  OPENROUTER_API_KEY       Anahtari diske yazmadan vermek icin
  CLAUDE_OPENROUTER_DIR    Yapilandirma dizini (varsayilan ~/.claude-openrouter)
`;
