import { NextRequest } from 'next/server'
import { DELETE as unregisterLegacy } from '@/app/api/mobile/push-token/route'

export async function POST(request: NextRequest) {
  return unregisterLegacy(request)
}
