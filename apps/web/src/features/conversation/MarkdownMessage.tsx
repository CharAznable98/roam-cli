import { Check, Copy } from "lucide-react";
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { codeToHtml } from "shiki";
import "katex/dist/katex.min.css";

const markdownComponents: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ alt, src }) {
    return <img alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" src={src} />;
  },
  blockquote({ children }) {
    const alert = githubAlert(children);
    if (alert) {
      return (
        <aside className={`markdown-alert ${alert.kind.toLowerCase()}`}>
          <div className="markdown-alert-title">{alert.kind}</div>
          {alert.children}
        </aside>
      );
    }
    return <blockquote>{children}</blockquote>;
  },
  code({ children, className }) {
    const code = String(children).replace(/\n$/, "");
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!language) {
      return <code>{children}</code>;
    }
    if (language === "mermaid") {
      return <MermaidBlock chart={code} />;
    }
    return <CodeBlock code={code} language={language} />;
  },
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(undefined);
    void codeToHtml(code, {
      lang: language,
      theme: "github-light",
    })
      .then((nextHtml) => {
        if (!cancelled) {
          setHtml(nextHtml);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const copy = async () => {
    if (!navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{language}</span>
        <button type="button" className="small-icon-button" onClick={copy} aria-label={`Copy ${language} code`} title="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {html === undefined ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : html.length > 0 ? (
        <div className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
        const result = await mermaid.render(`roamcli-mermaid-${id}`, chart);
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (svg === undefined) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }
  if (svg.length === 0) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function githubAlert(children: ReactNode): { kind: string; children: ReactNode } | undefined {
  const items = Array.isArray(children) ? children : [children];
  const first = items[0];
  if (!isValidElement<{ children?: ReactNode }>(first)) {
    return undefined;
  }
  const nested = Array.isArray(first.props.children) ? first.props.children : [first.props.children];
  const marker = typeof nested[0] === "string" ? nested[0].trim() : "";
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/.exec(marker);
  if (!match) {
    return undefined;
  }
  const nextNested = [...nested];
  nextNested[0] = String(nextNested[0]).replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/, "");
  const nextFirst = cloneElement(first, undefined, nextNested);
  return { kind: match[1] ?? "NOTE", children: [nextFirst, ...items.slice(1)] };
}
