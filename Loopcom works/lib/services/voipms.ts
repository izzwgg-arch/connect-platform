// VoIP.ms SMS/MMS API Integration
// Documentation: https://voip.ms/m/api.php

const VOIPMS_API_BASE = 'https://voip.ms/api/v1/rest.php'
const VOIPMS_USERNAME = process.env.VOIPMS_API_USERNAME
const VOIPMS_PASSWORD = process.env.VOIPMS_API_PASSWORD
const VOIPMS_DID = process.env.VOIPMS_DID

interface VoipMsSMSRequest {
  did: string
  dst: string
  message: string
  unicode?: boolean
}

interface VoipMsSMSResponse {
  status: string
  sms?: {
    id: string
    status: string
  }
}

interface VoipMsInboundSMS {
  id: string
  from: string
  to: string
  message: string
  datetime: string
}

export class VoipMsService {
  private async makeRequest(params: Record<string, string>): Promise<any> {
    if (!VOIPMS_USERNAME || !VOIPMS_PASSWORD) {
      throw new Error('VoIP.ms credentials not configured')
    }

    const queryParams = new URLSearchParams({
      api_username: VOIPMS_USERNAME,
      api_password: VOIPMS_PASSWORD,
      ...params,
    })

    const url = `${VOIPMS_API_BASE}?${queryParams.toString()}`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`VoIP.ms API error: ${response.statusText}`)
    }

    const data = await response.json()
    
    if (data.status !== 'success') {
      throw new Error(data.error || 'VoIP.ms API error')
    }

    return data
  }

  async sendSMS(request: VoipMsSMSRequest): Promise<VoipMsSMSResponse> {
    return this.makeRequest({
      method: 'sendSMS',
      did: request.did || VOIPMS_DID || '',
      dst: request.dst,
      message: request.message,
      unicode: request.unicode ? '1' : '0',
    })
  }

  async getInboundSMS(did?: string, dateFrom?: string, dateTo?: string): Promise<VoipMsInboundSMS[]> {
    const params: Record<string, string> = {
      method: 'getSMS',
    }

    if (did) params.did = did
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo

    const response = await this.makeRequest(params)
    return response.sms || []
  }

  async getMMS(did?: string, dateFrom?: string, dateTo?: string): Promise<any[]> {
    const params: Record<string, string> = {
      method: 'getMMS',
    }

    if (did) params.did = did
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo

    const response = await this.makeRequest(params)
    return response.mms || []
  }
}

export const voipMsService = new VoipMsService()
