'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatDate } from '@/lib/utils'
import { Search, BookOpen, HelpCircle, FileText, Plus } from 'lucide-react'
import Link from 'next/link'

interface HelpArticle {
  id: string
  title: string
  module: string
  category: string | null
  isPublished: boolean
}

const moduleColors: Record<string, string> = {
  DASHBOARD: 'bg-blue-100 text-blue-800',
  CLIENTS: 'bg-green-100 text-green-800',
  LEADS: 'bg-purple-100 text-purple-800',
  JOBS: 'bg-orange-100 text-orange-800',
  ESTIMATES: 'bg-yellow-100 text-yellow-800',
  INVOICES: 'bg-red-100 text-red-800',
  SCHEDULING: 'bg-indigo-100 text-indigo-800',
  TASKS: 'bg-pink-100 text-pink-800',
  ISSUES: 'bg-gray-100 text-gray-800',
  GENERAL: 'bg-gray-100 text-gray-800',
}

export default function HelpPage() {
  const router = useRouter()
  const [articles, setArticles] = useState<HelpArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [module, setModule] = useState('all')
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [userRole, setUserRole] = useState<string>('')

  useEffect(() => {
    // Get user role from token or API
    const token = localStorage.getItem('accessToken')
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        setUserRole(payload.role || '')
      } catch {
        // Ignore
      }
    }
  }, [])

  useEffect(() => {
    setPage(1)
  }, [search, module, category])

  useEffect(() => {
    fetchArticles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, module, category, page])

  const fetchArticles = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search,
        module,
        category,
        page: String(page),
        limit: '50',
      })

      const response = await fetch(`/api/help?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setArticles(data.articles || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch articles:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading help articles...</p>
        </div>
      </div>
    )
  }

  const publishedArticles = articles.filter((a) => a.isPublished)
  const regularArticles = articles.filter((a) => !a.isPublished)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Help & Instructions</h1>
          <p className="mt-2 text-gray-600">Find answers and learn how to use Trim Pro</p>
        </div>
        {userRole === 'ADMIN' && (
          <Button onClick={() => router.push('/dashboard/help/new')}>
            <Plus className="mr-2 h-4 w-4" />
            New Article
          </Button>
        )}
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search help articles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Modules" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Modules</SelectItem>
                <SelectItem value="DASHBOARD">Dashboard</SelectItem>
                <SelectItem value="CLIENTS">Clients</SelectItem>
                <SelectItem value="LEADS">Leads</SelectItem>
                <SelectItem value="JOBS">Jobs</SelectItem>
                <SelectItem value="ESTIMATES">Estimates</SelectItem>
                <SelectItem value="INVOICES">Invoices</SelectItem>
                <SelectItem value="SCHEDULING">Scheduling</SelectItem>
                <SelectItem value="TASKS">Tasks</SelectItem>
                <SelectItem value="ISSUES">Issues</SelectItem>
                <SelectItem value="GENERAL">General</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Published Articles */}
      {publishedArticles.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Published Articles</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {publishedArticles.map((article) => (
              <Card
                key={article.id}
                className="hover:shadow-lg transition-shadow cursor-pointer border-blue-300"
                onClick={() => router.push(`/dashboard/help/${article.id}`)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <BookOpen className="h-5 w-5 text-blue-600 mt-1" />
                    <span className={`px-2 py-1 text-xs rounded ${moduleColors[article.module] || 'bg-gray-100 text-gray-800'}`}>
                      {article.module}
                    </span>
                  </div>
                  <CardTitle className="text-lg">{article.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{article.category}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* All Articles */}
      <div>
        <h2 className="text-xl font-semibold mb-4">All Articles</h2>
        {regularArticles.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <HelpCircle className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No articles found</h3>
              <p className="mt-1 text-sm text-gray-500">
                {search ? 'Try a different search term.' : 'No help articles available yet.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {regularArticles.map((article) => (
              <Card
                key={article.id}
                className="hover:shadow-lg transition-shadow cursor-pointer"
                onClick={() => router.push(`/dashboard/help/${article.id}`)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <FileText className="h-5 w-5 text-gray-600 mt-1" />
                    <span className={`px-2 py-1 text-xs rounded ${moduleColors[article.module] || 'bg-gray-100 text-gray-800'}`}>
                      {article.module}
                    </span>
                  </div>
                  <CardTitle className="text-lg">{article.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{article.category}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={loading}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}
