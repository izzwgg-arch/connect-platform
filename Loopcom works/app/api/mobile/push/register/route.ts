import { NextRequest } from 'next/server'
import { POST as registerLegacy } from '@/app/api/mobile/push-token/route'

export async function POST(request: NextRequest) {
  return registerLegacy(request)
}
