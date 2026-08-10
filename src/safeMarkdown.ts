export interface ProtectedRemoteUrl {
  token: string;
  url: string;
}

export interface ProtectedMarkdown {
  markdown: string;
  remoteUrls: ProtectedRemoteUrl[];
}

/**
 * Remove remote URLs before untrusted model Markdown reaches Obsidian's
 * renderer. This prevents images, iframes, media, and raw HTML from issuing a
 * request during rendering. The UI restores placeholders only as click links.
 */
export function protectRemoteMarkdownUrls(markdown: string): ProtectedMarkdown {
  let prefix = "vaultmuse-remote-url";
  while (markdown.includes(prefix)) prefix = `${prefix}-x`;

  const remoteUrls: ProtectedRemoteUrl[] = [];
  const protectedText = markdown.replace(
    /https?:\/\/[^\s<>"'`)\]]+/giu,
    (url) => {
      const token = `${prefix}-${remoteUrls.length}-placeholder`;
      remoteUrls.push({ token, url });
      return token;
    },
  );

  return { markdown: protectedText, remoteUrls };
}
