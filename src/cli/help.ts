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
  remove <model-id>        Modeli listeden cikar
  list                     Ekli modelleri goster
  search <kelime>          OpenRouter katalogunda model ara

Claude Code ile birlestirme
  sync                     Modelleri ~/.claude/settings.json icindeki modelPicker'a yaz
  sync --revert            Son sync oncesi haline dondur
  claude [...]             Proxy'yi baslat ve claude'u ayni argumanlarla calistir

Proxy
  start                    Proxy'yi arka planda baslat
  stop                     Proxy'yi durdur
  status                   Durumu goster
  doctor                   Kurulumu bastan sona kontrol et

Ortam degiskenleri
  OPENROUTER_API_KEY       Anahtari diske yazmadan vermek icin
  CLAUDE_OPENROUTER_DIR    Yapilandirma dizini (varsayilan ~/.claude-openrouter)
`;
