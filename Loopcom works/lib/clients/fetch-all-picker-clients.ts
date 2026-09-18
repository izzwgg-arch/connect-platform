'use client'

export type PickerClient = {
  id: string
  name: string
  companyName?: string | null
  email?: string | null
  phone?: string | null
}

type ClientsResponse = {
  clients?: PickerClient[]
  pagination?: {
    totalPages?: number
    page?: number
  }
}

export async function fetchAllPickerClients(): Promise<PickerClient[]> {
  const token = localStorage.getItem('accessToken')
  const limit = 5000
  let page = 1
  let totalPages = 1
  const all: PickerClient[] = []

  do {
    const response = await fetch(`/api/clients/picker?limit=${limit}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new Error('Failed to load clients')
    }

    const data = (await response.json()) as ClientsResponse
    all.push(...(Array.isArray(data.clients) ? data.clients : []))
    totalPages = Math.max(1, Number(data.pagination?.totalPages || 1))
    page += 1
  } while (page <= totalPages)

  const seen = new Set<string>()
  return all.filter((client) => {
    if (!client?.id || seen.has(client.id)) return false
    seen.add(client.id)
    return true
  })
}
