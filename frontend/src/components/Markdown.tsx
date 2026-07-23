import { Box, Link, Typography } from "@mui/material";
import type { ReactNode } from "react";

// A compact, dependency-free Markdown renderer for release notes.
// Supports the subset GitHub release bodies typically use:
//   - # / ## / ### headers
//   - - or * bullet lists
//   - **bold**, `inline code`
//   - [text](url) links
//   - blank-line separated paragraphs
// Renders to MUI elements (no dangerouslySetInnerHTML → no XSS from remote text).

/// Render inline markdown (bold, code, links) within a single line.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Tokenize on **bold**, `code`, and [label](url).
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const key = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(
        <Box
          key={key}
          component="code"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.85em",
            px: 0.5,
            py: 0.1,
            borderRadius: 0.5,
            bgcolor: "action.hover",
          }}
        >
          {m[3]}
        </Box>,
      );
    } else if (m[4] !== undefined && m[5] !== undefined) {
      // Only allow http(s) links.
      const href = /^https?:\/\//.test(m[5]) ? m[5] : undefined;
      nodes.push(
        href ? (
          <Link key={key} href={href} target="_blank" rel="noopener noreferrer">
            {m[4]}
          </Link>
        ) : (
          m[4]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Props {
  content: string;
}

function normalizeNewlines(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.includes("\n")
    ? normalized
    : normalized.replace(/\\r\\n|\\n/g, "\n");
}

/// Block-level markdown renderer.
export function Markdown({ content }: Props) {
  const lines = normalizeNewlines(content).split("\n");
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = [...listItems];
    listItems = [];
    blocks.push(
      <Box key={`ul-${key++}`} component="ul" sx={{ pl: 3, my: 0.5 }}>
        {items.map((it, idx) => (
          <li key={idx}>
            <Typography variant="body2" component="span">
              {renderInline(it, `li-${key}-${idx}`)}
            </Typography>
          </li>
        ))}
      </Box>,
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);

    if (heading) {
      flushList();
      const level = heading[1].length;
      const variant = level === 1 ? "subtitle1" : "subtitle2";
      blocks.push(
        <Typography
          key={`h-${key++}`}
          variant={variant}
          sx={{ fontWeight: 700, mt: 1.5, mb: 0.5 }}
        >
          {renderInline(heading[2], `h-${key}`)}
        </Typography>,
      );
    } else if (bullet) {
      listItems.push(bullet[1]);
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(
        <Typography key={`p-${key++}`} variant="body2" sx={{ my: 0.5 }}>
          {renderInline(line, `p-${key}`)}
        </Typography>,
      );
    }
  }
  flushList();

  return <Box>{blocks}</Box>;
}
