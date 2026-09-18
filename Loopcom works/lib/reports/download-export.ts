/** Downloads an authenticated report export (CSV/PDF) as a file in the browser. */
export async function downloadReportExport(url: string, fallbackFilename: string): Promise<void> {
  const token = localStorage.getItem('accessToken')
  if (!token) throw new Error('Not authenticated')

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new Error(`Failed to generate export (${response.status})`)
  }

  const cd = response.headers.get('content-disposition') || ''
  const match = /filename="?([^";]+)"?/i.exec(cd)
  const filename = match?.[1]?.trim() || fallbackFilename

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(objectUrl)
}
