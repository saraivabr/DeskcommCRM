"use client";

import { ImageIcon, Sparkles } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { formats } from "@/lib/instagram/schema";
import styles from "./_image-generation.module.css";

/** Indeterminate feedback: generation does not expose a progress percentage. */
export function ImageGeneration({ format }: { format: keyof typeof formats }) {
  const t = useT();
  return (
    <div
      className={styles.frame}
      style={{ aspectRatio: formats[format].ratio }}
      role="status"
      aria-live="polite"
      aria-label={t("Criando sua imagem…")}
    >
      <div className={styles.art} aria-hidden="true">
        <div className={styles.glow} />
        <div className={styles.card}>
          <ImageIcon size={48} strokeWidth={1} />
          <div className={styles.scan} />
        </div>
        <Sparkles className={styles.sparkle} size={24} />
      </div>
      <div className={styles.copy}>
        <p className="font-serif text-2xl">{t("Criando sua imagem…")}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("Sua ideia está ganhando forma. Isso pode levar alguns minutos.")}
        </p>
      </div>
    </div>
  );
}
