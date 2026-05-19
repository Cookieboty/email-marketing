"use client";

import { useEffect } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  className,
  testId = "rich-text-editor",
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      Image.configure({ inline: false, allowBase64: false }),
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none min-h-[260px] px-3 py-2 focus:outline-none",
          disabled ? "opacity-60" : "",
        ),
        "data-testid": `${testId}-content`,
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
      },
    },
    onUpdate({ editor: ed }) {
      onChange(ed.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (value === editor.getHTML()) return;
    editor.commands.setContent(value || "", false);
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      className={cn("rounded-md border bg-background", className)}
      data-testid={testId}
    >
      <Toolbar editor={editor} disabled={disabled} testId={testId} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({
  editor,
  disabled,
  testId,
}: {
  editor: Editor | null;
  disabled?: boolean;
  testId: string;
}) {
  if (!editor) {
    return (
      <div
        className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1"
        data-testid={`${testId}-toolbar`}
      />
    );
  }

  function btn({
    label,
    onClick,
    active,
    disabled: btnDisabled,
    name,
  }: {
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    name: string;
  }) {
    return (
      <Button
        type="button"
        size="sm"
        variant={active ? "default" : "outline"}
        disabled={disabled || btnDisabled}
        onClick={onClick}
        data-testid={`${testId}-${name}`}
      >
        {label}
      </Button>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1"
      data-testid={`${testId}-toolbar`}
    >
      {btn({
        label: "B",
        name: "bold",
        active: editor.isActive("bold"),
        onClick: () => editor.chain().focus().toggleBold().run(),
      })}
      {btn({
        label: "I",
        name: "italic",
        active: editor.isActive("italic"),
        onClick: () => editor.chain().focus().toggleItalic().run(),
      })}
      {btn({
        label: "S",
        name: "strike",
        active: editor.isActive("strike"),
        onClick: () => editor.chain().focus().toggleStrike().run(),
      })}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn({
        label: "H1",
        name: "h1",
        active: editor.isActive("heading", { level: 1 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 1 }).run(),
      })}
      {btn({
        label: "H2",
        name: "h2",
        active: editor.isActive("heading", { level: 2 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 2 }).run(),
      })}
      {btn({
        label: "H3",
        name: "h3",
        active: editor.isActive("heading", { level: 3 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 3 }).run(),
      })}
      {btn({
        label: "P",
        name: "paragraph",
        active: editor.isActive("paragraph"),
        onClick: () => editor.chain().focus().setParagraph().run(),
      })}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn({
        label: "• 列表",
        name: "bullet-list",
        active: editor.isActive("bulletList"),
        onClick: () => editor.chain().focus().toggleBulletList().run(),
      })}
      {btn({
        label: "1. 列表",
        name: "ordered-list",
        active: editor.isActive("orderedList"),
        onClick: () => editor.chain().focus().toggleOrderedList().run(),
      })}
      {btn({
        label: "❝",
        name: "blockquote",
        active: editor.isActive("blockquote"),
        onClick: () => editor.chain().focus().toggleBlockquote().run(),
      })}
      {btn({
        label: "─",
        name: "hr",
        onClick: () => editor.chain().focus().setHorizontalRule().run(),
      })}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn({
        label: "链接",
        name: "link",
        active: editor.isActive("link"),
        onClick: () => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url =
            typeof window === "undefined"
              ? null
              : window.prompt("链接 URL（留空移除）", prev ?? "https://");
          if (url === null) return;
          if (url === "") {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }
          if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
            window.alert("仅支持 http(s):// 或 mailto: 链接");
            return;
          }
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
        },
      })}
      {btn({
        label: "图片",
        name: "image",
        onClick: () => {
          const url =
            typeof window === "undefined"
              ? null
              : window.prompt("图片 URL", "https://");
          if (!url) return;
          editor.chain().focus().setImage({ src: url }).run();
        },
      })}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn({
        label: "↶",
        name: "undo",
        disabled: !editor.can().undo(),
        onClick: () => editor.chain().focus().undo().run(),
      })}
      {btn({
        label: "↷",
        name: "redo",
        disabled: !editor.can().redo(),
        onClick: () => editor.chain().focus().redo().run(),
      })}
    </div>
  );
}

export function insertVariableAtCursor(editor: Editor | null, name: string): void {
  if (!editor) return;
  editor.chain().focus().insertContent(`{{${name}}}`).run();
}

export function insertHtmlAtCursor(editor: Editor | null, html: string): void {
  if (!editor) return;
  editor.chain().focus().insertContent(html).run();
}
