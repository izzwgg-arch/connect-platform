import { splitEmailList } from '@/lib/email'

type ClientContactLike = {
  email?: string | null
  phone?: string | null
  mobile?: string | null
}

type ClientContactSource = {
  email?: string | null
  phone?: string | null
  contacts?: ClientContactLike[] | null
}

/** Comma-separated emails from client record and linked contacts. */
export function collectClientEmailsOnFile(client: ClientContactSource | null | undefined): string {
  if (!client) return ''

  const emails = Array.from(
    new Set(
      [
        ...splitEmailList(client.email || ''),
        ...(client.contacts || []).flatMap((contact) => splitEmailList(contact.email || '')),
      ]
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )

  return emails.join(', ')
}

/** Phone numbers from client record and linked contacts (deduped, comma-separated). */
export function collectClientPhonesOnFile(client: ClientContactSource | null | undefined): string {
  if (!client) return ''

  const phones = Array.from(
    new Set(
      [client.phone || '', ...(client.contacts || []).flatMap((contact) => [contact.phone || '', contact.mobile || ''])]
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )

  return phones.join(', ')
}
