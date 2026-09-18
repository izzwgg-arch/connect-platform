/**
 * Pagination utilities
 */

export interface PaginationParams {
  page?: number
  limit?: number
  offset?: number
}

export interface PaginationResult {
  total: number
  limit: number
  offset: number
  page: number
  totalPages: number
  hasMore: boolean
}

/**
 * Calculate pagination values from query params
 */
export function getPaginationParams(searchParams: URLSearchParams): {
  skip: number
  take: number
  page: number
  limit: number
} {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)))
  const skip = (page - 1) * limit

  return { skip, take: limit, page, limit }
}

/**
 * Create pagination response metadata
 */
export function createPaginationResponse(
  total: number,
  limit: number,
  offset: number
): PaginationResult {
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)

  return {
    total,
    limit,
    offset,
    page,
    totalPages,
    hasMore: offset + limit < total,
  }
}

/**
 * Standard paginated response format
 */
export interface PaginatedResponse<T> {
  data: T[]
  pagination: PaginationResult
}
