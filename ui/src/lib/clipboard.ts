/**
 * Sao chép chuỗi vào clipboard một cách an toàn:
 * - Ưu tiên `navigator.clipboard.writeText` (try/catch).
 * - Fallback sang `document.execCommand("copy")` cho ngữ cảnh không bảo mật hoặc khi Clipboard API bị chặn.
 * - Không bao giờ throw hay tạo unhandled rejection; trả về `true` nếu thành công, `false` nếu thất bại.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback sang execCommand bên dưới
    }
  }

  if (typeof document === "undefined" || !document.body) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    return typeof document.execCommand === "function"
      ? document.execCommand("copy")
      : false;
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
