import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentOptions {
  name: string;
  modelId: string;
  /** "project" writes .claude/agents, "user" writes ~/.claude/agents. */
  scope: "project" | "user";
  label?: string;
}

/** The `.claude` directory for a scope — shared with agentDiscovery.ts. */
export function claudeDir(scope: AgentOptions["scope"]): string {
  return scope === "user"
    ? (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
    : join(process.cwd(), ".claude");
}

export function agentsDir(scope: AgentOptions["scope"]): string {
  return join(claudeDir(scope), "agents");
}

export function agentPath(name: string, scope: AgentOptions["scope"]): string {
  return join(agentsDir(scope), `${name}.md`);
}

/**
 * A subagent that runs on an OpenRouter model and edits one file.
 *
 * The short tool list is the point, not only a safety rail: the models that
 * write tool calls as prose do it under Claude Code's full tool set, and are
 * far steadier with a handful of tools.
 */
export function renderAgent(options: AgentOptions): string {
  const label = options.label ?? options.modelId;

  return `---
name: ${options.name}
description: Tek bir dosyada, verilen plana gore kod yazar. Plani ve dosya yolunu gorev metninde ver. Plan yapmaz, arastirma yapmaz, baska dosyaya dokunmaz.
model: ${options.modelId}
tools: Read, Edit, Write
permissionMode: acceptEdits
maxTurns: 30
omitClaudeMd: true
color: cyan
---

Sen ${label} uzerinde calisan bir uygulayicisin. Sana bir plan ve **tek bir dosya yolu** verilir. Isin o plani o dosyaya uygulamak.

## Kurallar

1. **Sadece sana verilen dosyayi degistir.** Baska hicbir dosyaya yazma.
2. Once dosyayi Read ile bastan sona oku. Okumadan duzenleme yapma.
3. Plani oldugu gibi uygula. Plan disinda iyilestirme, yeniden duzenleme, ek ozellik ekleme.
4. Mevcut kodun bicimine uy: ayni girinti, ayni isimlendirme, ayni yorum yogunlugu.
5. Bir sey eksikse veya plan bu dosyada uygulanamiyorsa **durup bildir**. Tahmin etme, baska dosyaya gecme.
6. Islemin sonunda ne degistirdigini kisa ve net ozetle: hangi fonksiyon/bolum, neden.

## Sinirlarin

- Arastirma, plan, mimari karari senin isin degil; onlar sana hazir gelir.
- Elinde sadece Read, Edit ve Write var. Komut calistiramaz, dosya arayamazsin.
- Testleri sen calistirmazsin. Gerekiyorsa ozetinde belirt.
`;
}

export function writeAgent(options: AgentOptions): { path: string; overwritten: boolean } {
  const path = agentPath(options.name, options.scope);
  const overwritten = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderAgent(options));
  return { path, overwritten };
}
