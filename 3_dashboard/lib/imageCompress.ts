// Downscale + re-encode a large screenshot to JPEG so it uploads reliably on weak
// mobile connections (a multi-MB photo becomes a few hundred KB). Text stays
// readable at 1920px. Falls back to the original file on any failure or if the
// result isn't actually smaller. Browser-only (uses canvas / createImageBitmap).
export async function compressImage(file: File): Promise<{ data: Blob; type: string; name: string }> {
  const orig = { data: file as Blob, type: file.type, name: file.name }
  if (!file.type.startsWith('image/') || file.size < 500 * 1024) return orig
  try {
    const bitmap = await createImageBitmap(file)
    const MAX = 1920
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return orig
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    if (blob && blob.size < file.size) {
      const name = file.name.replace(/\.(png|webp|heic|heif|bmp|gif|jpeg|jpg)$/i, '') + '.jpg'
      return { data: blob, type: 'image/jpeg', name }
    }
    return orig
  } catch {
    return orig
  }
}
