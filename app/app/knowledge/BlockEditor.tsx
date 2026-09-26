"use client";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useRef, useState } from "react";
export default function BlockEditor({
  markdown,
  editable,
  onChange,
}: {
  markdown: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const editor = useCreateBlockNote();
  const loaded = useRef(false);
  const initialized = useRef(false);
  const lastValue = useRef(markdown);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(markdown));
    lastValue.current = editor.blocksToMarkdownLossy(editor.document);
    initialized.current = true;
    setReady(true);
  }, [editor, markdown]);
  return (
    <BlockNoteView
      editor={editor}
      editable={editable && ready}
      onChange={() => {
        if (!initialized.current) return;
        const value = editor.blocksToMarkdownLossy(editor.document);
        if (value !== lastValue.current) {
          lastValue.current = value;
          onChange(value);
        }
      }}
    />
  );
}
