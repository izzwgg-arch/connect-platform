'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { formatDate, formatTime } from '@/lib/utils'
import { smartMatch } from '@/lib/search/scoring'
import { JOB_STATUSES, formatJobStatus, jobStatusHexColors } from '@/lib/jobs/statuses'
import { GoogleMapsLoader } from '@/components/maps/GoogleMapsLoader'
import {
  Map,
  MapPin,
  Calendar,
  Filter,
  Search,
  Navigation,
  CheckCircle,
  X,
  ExternalLink,
  Briefcase,
  Users,
  User,
  RefreshCw,
} from 'lucide-react'
import Link from 'next/link'

interface MapJob {
  id: string
  jobNumber: string
  title: string
  status: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  latitude: number
  longitude: number
  address: {
    street: string
    city: string
    state: string
    zipCode: string
  }
  client: {
    id: string
    name: string
    companyName: string | null
  }
  assignedTechs: Array<{
    id: string
    name: string
  }>
}

interface MapClient {
  id: string
  name: string
  companyName: string | null
  latitude: number
  longitude: number
  address: {
    street: string
    city: string
    state: string
    zipCode: string
  }
}

interface MapTech {
  id: string
  name: string
  phone: string | null
  latitude: number | null
  longitude: number | null
  hasLocation: boolean
}

interface MapData {
  jobs: MapJob[]
  clients: MapClient[]
  techs: MapTech[]
}

const statusColors = jobStatusHexColors

export default function MapsPage() {
  const router = useRouter()
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const [loading, setLoading] = useState(true)
  const [mapData, setMapData] = useState<MapData>({ jobs: [], clients: [], techs: [] })
  const [selectedJob, setSelectedJob] = useState<MapJob | null>(null)
  const [selectedClient, setSelectedClient] = useState<MapClient | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [dateRange, setDateRange] = useState('today')
  const [statusFilter, setStatusFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [techIdFilter, setTechIdFilter] = useState<string>('all')
  const [showJobs, setShowJobs] = useState(true)
  const [showClients, setShowClients] = useState(false)
  const [showTechs, setShowTechs] = useState(false)
  const [geocodingProgress, setGeocodingProgress] = useState<{ processing: boolean; count: number }>({
    processing: false,
    count: 0,
  })
  const [techsList, setTechsList] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    fetchMapData()
    fetchTechs()
  }, [dateRange, statusFilter, priorityFilter, techIdFilter, showJobs, showClients, showTechs])

  const fetchMapData = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const params = new URLSearchParams({
        dateRange,
        showJobs: showJobs.toString(),
        showClients: showClients.toString(),
        showTechs: showTechs.toString(),
      })

      if (statusFilter !== 'all') params.append('status', statusFilter)
      if (priorityFilter !== 'all') params.append('priority', priorityFilter)
      if (techIdFilter !== 'all') params.append('techId', techIdFilter)

      const response = await fetch(`/api/maps/data?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (response.ok) {
        const data = await response.json()
        setMapData(data)
        updateMapMarkers(data)
      }
    } catch (error) {
      console.error('Failed to fetch map data:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchTechs = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/users?role=FIELD&limit=100', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        setTechsList(
          (data.users || []).map((u: any) => ({
            id: u.id,
            name: `${u.firstName} ${u.lastName}`,
          }))
        )
      }
    } catch (error) {
      console.error('Failed to fetch techs:', error)
    }
  }

  const updateMapMarkers = (data: MapData) => {
    if (!mapInstanceRef.current || !window.google) return

    // Clear existing markers
    markersRef.current.forEach((marker) => marker.setMap(null))
    markersRef.current = []

    const bounds = new (window as any).google.maps.LatLngBounds()
    let hasBounds = false

    // Add job markers
    if (showJobs) {
      data.jobs.forEach((job) => {
        const position = { lat: job.latitude, lng: job.longitude }
        const marker = new (window as any).google.maps.Marker({
          position,
          map: mapInstanceRef.current,
          title: `${job.jobNumber}: ${job.title}`,
          icon: {
            url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new (window as any).google.maps.Size(32, 32),
          },
        })

        marker.addListener('click', () => {
          setSelectedJob(job)
          setSelectedClient(null)
        })

        markersRef.current.push(marker)
        bounds.extend(position)
        hasBounds = true
      })
    }

    // Add client markers
    if (showClients) {
      data.clients.forEach((client) => {
        const position = { lat: client.latitude, lng: client.longitude }
        const marker = new (window as any).google.maps.Marker({
          position,
          map: mapInstanceRef.current,
          title: client.name,
          icon: {
            url: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png',
            scaledSize: new (window as any).google.maps.Size(32, 32),
          },
        })

        marker.addListener('click', () => {
          setSelectedClient(client)
          setSelectedJob(null)
        })

        markersRef.current.push(marker)
        bounds.extend(position)
        hasBounds = true
      })
    }

    // Add tech markers (if they have location)
    if (showTechs) {
      data.techs
        .filter((tech) => tech.hasLocation && tech.latitude && tech.longitude)
        .forEach((tech) => {
          const position = { lat: tech.latitude!, lng: tech.longitude! }
          const marker = new (window as any).google.maps.Marker({
            position,
            map: mapInstanceRef.current,
            title: tech.name,
            icon: {
              url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
              scaledSize: new (window as any).google.maps.Size(32, 32),
            },
          })

          markersRef.current.push(marker)
          bounds.extend(position)
          hasBounds = true
        })
    }

    // Fit bounds or default center
    if (hasBounds) {
      mapInstanceRef.current.fitBounds(bounds)
    } else {
      mapInstanceRef.current.setCenter({ lat: 39.8283, lng: -98.5795 }) // Center of US
      mapInstanceRef.current.setZoom(4)
    }
  }

  // Initialize map when Google Maps loads
  useEffect(() => {
    if (typeof window === 'undefined') return

    const checkAndInitMap = () => {
      if (window.google && window.google.maps && mapRef.current && !mapInstanceRef.current) {
        const map = new (window as any).google.maps.Map(mapRef.current, {
          center: { lat: 39.8283, lng: -98.5795 },
          zoom: 4,
          mapTypeControl: true,
          streetViewControl: true,
          fullscreenControl: true,
        })

        mapInstanceRef.current = map
        if (mapData.jobs.length > 0 || mapData.clients.length > 0 || mapData.techs.length > 0) {
          updateMapMarkers(mapData)
        }
      }
    }

    // Check immediately
    checkAndInitMap()

    // Check periodically in case maps loads later
    const interval = setInterval(checkAndInitMap, 500)
    
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update markers when data or layer visibility changes
  useEffect(() => {
    if (mapInstanceRef.current && (mapData.jobs.length > 0 || mapData.clients.length > 0 || mapData.techs.length > 0)) {
      updateMapMarkers(mapData)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData, showJobs, showClients, showTechs])

  const handleGeocodeMissing = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return

      setGeocodingProgress({ processing: true, count: 0 })

      // Fetch addresses without lat/lng
      const jobsResponse = await fetch('/api/jobs?limit=1000', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const jobsData = await jobsResponse.json()
      const jobs = jobsData.jobs || []

      const addressesToGeocode: string[] = []
      for (const job of jobs) {
        const jobDetailResponse = await fetch(`/api/jobs/${job.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (jobDetailResponse.ok) {
          const jobDetail = await jobDetailResponse.json()
          if (jobDetail.job?.addresses) {
            jobDetail.job.addresses
              .filter((addr: any) => !addr.latitude || !addr.longitude)
              .forEach((addr: any) => {
                addressesToGeocode.push(addr.id)
              })
          }
        }
      }

      if (addressesToGeocode.length > 0) {
        setGeocodingProgress({ processing: true, count: addressesToGeocode.length })

        const geocodeResponse = await fetch('/api/geocoding/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ addressIds: addressesToGeocode }),
        })

        if (geocodeResponse.ok) {
          const result = await geocodeResponse.json()
          alert(`Geocoded ${result.successCount} addresses successfully.`)
          fetchMapData() // Refresh map data
        }
      } else {
        alert('All addresses are already geocoded.')
      }
    } catch (error) {
      console.error('Geocoding error:', error)
      alert('Failed to geocode addresses. Please try again.')
    } finally {
      setGeocodingProgress({ processing: false, count: 0 })
    }
  }

  const getDirectionsUrl = (lat: number, lng: number) => {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
  }

  const filteredJobs = mapData.jobs.filter((job) =>
    smartMatch(searchQuery, [
      job.jobNumber,
      job.title,
      job.client.name,
      job.address.street,
      job.address.city,
      job.address.state,
      job.address.zipCode,
    ])
  )

  const hasGeocodedData = mapData.jobs.length > 0 || mapData.clients.length > 0

  return (
    <GoogleMapsLoader>
      <div className="space-y-4 h-[calc(100vh-8rem)] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Maps</h1>
            <p className="mt-1 text-gray-600">View jobs, clients, and technicians on a map</p>
          </div>
          {!hasGeocodedData && (
            <Button onClick={handleGeocodeMissing} disabled={geocodingProgress.processing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${geocodingProgress.processing ? 'animate-spin' : ''}`} />
              {geocodingProgress.processing ? 'Geocoding...' : 'Geocode Missing Addresses'}
            </Button>
          )}
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="flex-1">
                <Label>Date Range</Label>
                <Select value={dateRange} onValueChange={setDateRange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="week">This Week</SelectItem>
                    <SelectItem value="month">This Month</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label>Job Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    {JOB_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label>Technician</Label>
                <Select value={techIdFilter} onValueChange={setTechIdFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Techs</SelectItem>
                    {techsList.map((tech) => (
                      <SelectItem key={tech.id} value={tech.id}>
                        {tech.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Job, client, address..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center space-x-4">
              <Label>Layers:</Label>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="show-jobs"
                  checked={showJobs}
                  onCheckedChange={(checked) => setShowJobs(checked === true)}
                />
                <Label htmlFor="show-jobs" className="font-normal cursor-pointer flex items-center">
                  <Briefcase className="h-4 w-4 mr-1 text-red-500" />
                  Jobs
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="show-clients"
                  checked={showClients}
                  onCheckedChange={(checked) => setShowClients(checked === true)}
                />
                <Label htmlFor="show-clients" className="font-normal cursor-pointer flex items-center">
                  <Users className="h-4 w-4 mr-1 text-blue-500" />
                  Clients
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="show-techs"
                  checked={showTechs}
                  onCheckedChange={(checked) => setShowTechs(checked === true)}
                />
                <Label htmlFor="show-techs" className="font-normal cursor-pointer flex items-center">
                  <User className="h-4 w-4 mr-1 text-green-500" />
                  Technicians
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Map and Sidebar */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-4 min-h-0">
          {/* Left Panel - Job List */}
          <Card className="lg:col-span-1 overflow-hidden flex flex-col">
            <CardHeader>
              <CardTitle className="text-lg">Jobs ({filteredJobs.length})</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="text-center py-8 text-gray-500">Loading...</div>
              ) : filteredJobs.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  {hasGeocodedData
                    ? 'No jobs match your filters'
                    : 'No geocoded addresses found. Click "Geocode Missing Addresses" to add locations.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredJobs.map((job) => (
                    <div
                      key={job.id}
                      onClick={() => {
                        setSelectedJob(job)
                        setSelectedClient(null)
                        // Center map on job
                        if (mapInstanceRef.current) {
                          mapInstanceRef.current.setCenter({ lat: job.latitude, lng: job.longitude })
                          mapInstanceRef.current.setZoom(15)
                        }
                      }}
                      className={`p-3 rounded border cursor-pointer transition-colors ${
                        selectedJob?.id === job.id ? 'border-primary bg-primary/5' : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="font-semibold text-sm">{job.jobNumber}</div>
                          <div className="text-xs text-gray-600 mt-1">{job.title}</div>
                          <div className="text-xs text-gray-500 mt-1">
                            {job.address.city}, {job.address.state}
                          </div>
                        </div>
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0 mt-1"
                          style={{ backgroundColor: statusColors[job.status] || '#gray' }}
                        />
                      </div>
                      {job.scheduledStart && (
                        <div className="text-xs text-gray-500 mt-2 flex items-center">
                          <Calendar className="h-3 w-3 mr-1" />
                          {formatDate(job.scheduledStart)}
                          {job.scheduledEnd && ` - ${formatTime(job.scheduledEnd)}`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Map */}
          <Card className="lg:col-span-3 overflow-hidden flex flex-col">
            <CardContent className="flex-1 p-0">
              <div ref={mapRef} className="w-full h-full min-h-[500px]" />
              {typeof window !== 'undefined' && window.google && (
                <script
                  dangerouslySetInnerHTML={{
                    __html: `
                      (function() {
                        if (!window.__mapInitialized) {
                          window.__mapInitialized = true;
                          setTimeout(() => {
                            const event = new Event('googleMapsReady');
                            window.dispatchEvent(event);
                          }, 100);
                        }
                      })();
                    `,
                  }}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Detail Drawer */}
        {(selectedJob || selectedClient) && (
          <Card className="absolute bottom-4 right-4 w-96 z-10 shadow-xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{selectedJob ? 'Job Details' : 'Client Details'}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setSelectedJob(null) || setSelectedClient(null)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {selectedJob && (
                <div className="space-y-4">
                  <div>
                    <div className="font-semibold text-lg">{selectedJob.jobNumber}</div>
                    <div className="text-sm text-gray-600">{selectedJob.title}</div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span
                      className="px-2 py-1 text-xs rounded-full text-white"
                      style={{ backgroundColor: statusColors[selectedJob.status] || '#gray' }}
                    >
                      {formatJobStatus(selectedJob.status)}
                    </span>
                    <span className="text-xs text-gray-500">Priority: {selectedJob.priority}</span>
                  </div>

                  <div>
                    <div className="text-sm font-medium">Client</div>
                    <Link href={`/dashboard/clients/${selectedJob.client.id}`} className="text-sm text-primary hover:underline">
                      {selectedJob.client.name}
                    </Link>
                  </div>

                  <div>
                    <div className="text-sm font-medium">Address</div>
                    <div className="text-sm text-gray-600">
                      {selectedJob.address.street}, {selectedJob.address.city}, {selectedJob.address.state}{' '}
                      {selectedJob.address.zipCode}
                    </div>
                  </div>

                  {selectedJob.scheduledStart && (
                    <div>
                      <div className="text-sm font-medium">Scheduled</div>
                      <div className="text-sm text-gray-600">
                        {formatDate(selectedJob.scheduledStart)}
                        {selectedJob.scheduledEnd && ` - ${formatTime(selectedJob.scheduledEnd)}`}
                      </div>
                    </div>
                  )}

                  {selectedJob.assignedTechs.length > 0 && (
                    <div>
                      <div className="text-sm font-medium">Assigned Techs</div>
                      <div className="text-sm text-gray-600">
                        {selectedJob.assignedTechs.map((t) => t.name).join(', ')}
                      </div>
                    </div>
                  )}

                  <div className="flex space-x-2 pt-2">
                    <Link href={`/dashboard/jobs/${selectedJob.id}`} className="flex-1">
                      <Button className="w-full" size="sm">
                        Open Job
                      </Button>
                    </Link>
                    <a
                      href={getDirectionsUrl(selectedJob.latitude, selectedJob.longitude)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1"
                    >
                      <Button variant="outline" className="w-full" size="sm">
                        <Navigation className="h-4 w-4 mr-1" />
                        Navigate
                      </Button>
                    </a>
                  </div>
                </div>
              )}

              {selectedClient && (
                <div className="space-y-4">
                  <div>
                    <div className="font-semibold text-lg">{selectedClient.name}</div>
                    {selectedClient.companyName && <div className="text-sm text-gray-600">{selectedClient.companyName}</div>}
                  </div>

                  <div>
                    <div className="text-sm font-medium">Address</div>
                    <div className="text-sm text-gray-600">
                      {selectedClient.address.street}, {selectedClient.address.city}, {selectedClient.address.state}{' '}
                      {selectedClient.address.zipCode}
                    </div>
                  </div>

                  <div className="flex space-x-2 pt-2">
                    <Link href={`/dashboard/clients/${selectedClient.id}`} className="flex-1">
                      <Button className="w-full" size="sm">
                        Open Client
                      </Button>
                    </Link>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </GoogleMapsLoader>
  )
}
