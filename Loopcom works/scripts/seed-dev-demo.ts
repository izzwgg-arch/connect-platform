/**
 * Idempotent dev demo dataset for Trim Pro.
 * Uses admin@trimpro.com tenant. Re-run safely — clears prior demo data first.
 *
 * Usage: npx tsx scripts/seed-dev-demo.ts
 */
import {
  PrismaClient,
  LeadSource,
  LeadStatus,
  JobStatus,
  EstimateStatus,
  InvoiceStatus,
  PurchaseOrderStatus,
  ScheduleType,
  MessageChannel,
  MessageDirection,
  MessageStatus,
  ConversationStatus,
  ItemType,
  PaymentTerms,
  UserRole,
  UserStatus,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const DEMO_TAG = 'demo-seed'
const DOC_PREFIX = '900'

function dec(value: number | string) {
  return value
}

function daysFromNow(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

function daysAgo(days: number) {
  return daysFromNow(-days)
}

function atTime(date: Date, hours: number, minutes = 0) {
  const d = new Date(date)
  d.setHours(hours, minutes, 0, 0)
  return d
}

async function hashPassword(password: string) {
  return bcrypt.hash(password, 12)
}

async function clearDemoData(tenantId: string) {
  const demoClients = await prisma.client.findMany({
    where: { tenantId, tags: { has: DEMO_TAG } },
    select: { id: true },
  })
  const demoClientIds = demoClients.map((c) => c.id)

  const demoJobs = await prisma.job.findMany({
    where: {
      tenantId,
      OR: [
        { jobNumber: { startsWith: `JOB-${DOC_PREFIX}` } },
        ...(demoClientIds.length ? [{ clientId: { in: demoClientIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const demoJobIds = demoJobs.map((j) => j.id)

  const demoLeads = await prisma.lead.findMany({
    where: {
      tenantId,
      OR: [
        { notes: { contains: `[${DEMO_TAG}]` } },
        ...(demoClientIds.length ? [{ convertedToClientId: { in: demoClientIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const demoLeadIds = demoLeads.map((l) => l.id)

  const demoEstimates = await prisma.estimate.findMany({
    where: {
      tenantId,
      OR: [
        { estimateNumber: { startsWith: `EST-${DOC_PREFIX}` } },
        ...(demoClientIds.length ? [{ clientId: { in: demoClientIds } }] : []),
        ...(demoJobIds.length ? [{ jobId: { in: demoJobIds } }] : []),
        ...(demoLeadIds.length ? [{ leadId: { in: demoLeadIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const demoEstimateIds = demoEstimates.map((e) => e.id)

  const demoInvoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      OR: [
        { invoiceNumber: { startsWith: `INV-${DOC_PREFIX}` } },
        ...(demoClientIds.length ? [{ clientId: { in: demoClientIds } }] : []),
        ...(demoJobIds.length ? [{ jobId: { in: demoJobIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const demoInvoiceIds = demoInvoices.map((i) => i.id)

  const demoPOs = await prisma.purchaseOrder.findMany({
    where: {
      tenantId,
      OR: [
        { poNumber: { startsWith: `PO-${DOC_PREFIX}` } },
        ...(demoJobIds.length ? [{ jobId: { in: demoJobIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const demoPOIds = demoPOs.map((p) => p.id)

  if (
    !demoClientIds.length &&
    !demoJobIds.length &&
    !demoLeadIds.length &&
    !demoEstimateIds.length &&
    !demoInvoiceIds.length &&
    !demoPOIds.length
  ) {
    const vendorCount = await prisma.vendor.count({
      where: { tenantId, vendorCode: { startsWith: 'DEMO-' } },
    })
    if (!vendorCount) return
  }

  console.log('🧹 Clearing previous demo data...')

  if (demoClientIds.length) {
    await prisma.conversation.deleteMany({
      where: { tenantId, clientId: { in: demoClientIds } },
    })
  }

  if (demoInvoiceIds.length) {
    const payments = await prisma.payment.findMany({
      where: { invoiceId: { in: demoInvoiceIds } },
      select: { id: true },
    })
    if (payments.length) {
      await prisma.paymentRefund.deleteMany({
        where: { paymentId: { in: payments.map((p) => p.id) } },
      })
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } })
    }
    await prisma.invoicePaymentIntent.deleteMany({
      where: { invoiceId: { in: demoInvoiceIds } },
    })
    await prisma.invoice.deleteMany({ where: { id: { in: demoInvoiceIds } } })
  }

  if (demoEstimateIds.length) {
    await prisma.estimateApprovalToken.deleteMany({
      where: { estimateId: { in: demoEstimateIds } },
    })
    await prisma.estimateItemApproval.deleteMany({
      where: { estimateId: { in: demoEstimateIds } },
    })
    await prisma.estimate.deleteMany({ where: { id: { in: demoEstimateIds } } })
  }

  if (demoPOIds.length) {
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: demoPOIds } } })
  }

  if (demoJobIds.length || demoLeadIds.length) {
    await prisma.schedule.deleteMany({
      where: {
        tenantId,
        OR: [
          { description: { contains: `[${DEMO_TAG}]` } },
          ...(demoJobIds.length ? [{ jobId: { in: demoJobIds } }] : []),
          ...(demoLeadIds.length ? [{ leadId: { in: demoLeadIds } }] : []),
        ],
      },
    })
  }

  if (demoJobIds.length) {
    await prisma.timeEntry.deleteMany({ where: { jobId: { in: demoJobIds } } })
    await prisma.jobAssignment.deleteMany({ where: { jobId: { in: demoJobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: demoJobIds } } })
  }

  if (demoLeadIds.length) {
    await prisma.lead.deleteMany({ where: { id: { in: demoLeadIds } } })
  }
  if (demoClientIds.length) {
    await prisma.client.deleteMany({ where: { id: { in: demoClientIds } } })
  }

  await prisma.item.deleteMany({ where: { tenantId, sku: { startsWith: 'DEMO-' } } })
  await prisma.itemCategory.deleteMany({ where: { tenantId, name: { startsWith: 'Demo ' } } })
  await prisma.vendor.deleteMany({ where: { tenantId, vendorCode: { startsWith: 'DEMO-' } } })

  console.log('   ✅ Demo data cleared')
}

async function ensureDemoUsers(tenantId: string, adminId: string) {
  const users = []

  const defs = [
    {
      email: 'mike.tech@trimpro.com',
      firstName: 'Mike',
      lastName: 'Rodriguez',
      role: UserRole.FIELD,
    },
    {
      email: 'sarah.sales@trimpro.com',
      firstName: 'Sarah',
      lastName: 'Chen',
      role: UserRole.SALES,
    },
    {
      email: 'james.dispatch@trimpro.com',
      firstName: 'James',
      lastName: 'Wilson',
      role: UserRole.MANAGER,
    },
  ]

  const passwordHash = await hashPassword('demo123')

  for (const def of defs) {
    const existing = await prisma.user.findFirst({
      where: { tenantId, email: def.email },
    })
    if (existing) {
      users.push(existing)
      continue
    }
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: def.email,
        firstName: def.firstName,
        lastName: def.lastName,
        role: def.role,
        status: UserStatus.ACTIVE,
        passwordHash,
        lastPasswordChange: new Date(),
        managerId: def.role === UserRole.FIELD ? adminId : undefined,
      },
    })
    users.push(user)
  }

  return {
    admin: await prisma.user.findUniqueOrThrow({ where: { id: adminId } }),
    tech: users.find((u) => u.email === 'mike.tech@trimpro.com')!,
    sales: users.find((u) => u.email === 'sarah.sales@trimpro.com')!,
    dispatcher: users.find((u) => u.email === 'james.dispatch@trimpro.com')!,
  }
}

async function seedDemoData(tenantId: string, adminId: string) {
  const users = await ensureDemoUsers(tenantId, adminId)
  console.log('👥 Demo team users ready (password: demo123 for new accounts)')

  // --- Vendors & Items ---
  console.log('📦 Seeding vendors & items...')
  const vendorData = [
    {
      code: 'DEMO-LUMBER',
      name: 'Premier Lumber Supply',
      email: 'orders@premierlumber.example',
      phone: '(555) 201-4400',
      city: 'Brooklyn',
      state: 'NY',
    },
    {
      code: 'DEMO-HARDWARE',
      name: 'Atlas Hardware & Millwork',
      email: 'sales@atlashardware.example',
      phone: '(555) 201-5500',
      city: 'Queens',
      state: 'NY',
    },
    {
      code: 'DEMO-FINISH',
      name: 'Fine Finish Coatings',
      email: 'rep@finefinish.example',
      phone: '(555) 201-6600',
      city: 'Jersey City',
      state: 'NJ',
    },
  ]

  const vendors = []
  for (const v of vendorData) {
    const vendor = await prisma.vendor.create({
      data: {
        tenantId,
        vendorCode: v.code,
        name: v.name,
        email: v.email,
        phone: v.phone,
        paymentTerms: PaymentTerms.NET_30,
        billingStreet: '100 Industrial Blvd',
        billingCity: v.city,
        billingState: v.state,
        billingZip: '11201',
        contacts: {
          create: {
            tenantId,
            name: 'Order Desk',
            email: v.email,
            phone: v.phone,
            isPrimary: true,
          },
        },
      },
    })
    vendors.push(vendor)
  }

  const [lumberVendor, hardwareVendor, finishVendor] = vendors

  const moldingCat = await prisma.itemCategory.create({
    data: { tenantId, name: 'Demo Molding & Trim', description: 'Crown, base, casing' },
  })
  const laborCat = await prisma.itemCategory.create({
    data: { tenantId, name: 'Demo Labor', description: 'Installation services' },
  })
  const materialCat = await prisma.itemCategory.create({
    data: { tenantId, name: 'Demo Materials', description: 'Sheet goods and hardware' },
  })

  const itemDefs = [
    {
      sku: 'DEMO-CRWN-001',
      name: '5-1/4" Colonial Crown Molding',
      type: ItemType.MATERIAL,
      unit: 'lf',
      cost: 4.25,
      price: 8.5,
      vendorId: lumberVendor.id,
      categoryId: moldingCat.id,
    },
    {
      sku: 'DEMO-BASE-001',
      name: '7-1/4" Baseboard – Primed MDF',
      type: ItemType.MATERIAL,
      unit: 'lf',
      cost: 3.1,
      price: 6.75,
      vendorId: lumberVendor.id,
      categoryId: moldingCat.id,
    },
    {
      sku: 'DEMO-CASE-001',
      name: '3-1/2" Casing – Poplar',
      type: ItemType.MATERIAL,
      unit: 'lf',
      cost: 2.85,
      price: 5.95,
      vendorId: lumberVendor.id,
      categoryId: moldingCat.id,
    },
    {
      sku: 'DEMO-INST-LABOR',
      name: 'Trim Installation Labor',
      type: ItemType.SERVICE,
      unit: 'hr',
      cost: 45,
      price: 95,
      categoryId: laborCat.id,
    },
    {
      sku: 'DEMO-CAB-INST',
      name: 'Cabinet Installation',
      type: ItemType.SERVICE,
      unit: 'ea',
      cost: 350,
      price: 750,
      categoryId: laborCat.id,
    },
    {
      sku: 'DEMO-HINGE-001',
      name: 'Soft-Close Concealed Hinge (pair)',
      type: ItemType.PRODUCT,
      unit: 'pair',
      cost: 6.5,
      price: 14,
      vendorId: hardwareVendor.id,
      categoryId: materialCat.id,
    },
    {
      sku: 'DEMO-PAINT-001',
      name: 'Interior Trim Paint – Semi-Gloss',
      type: ItemType.MATERIAL,
      unit: 'gal',
      cost: 38,
      price: 65,
      vendorId: finishVendor.id,
      categoryId: materialCat.id,
    },
    {
      sku: 'DEMO-DELIVERY',
      name: 'Material Delivery Fee',
      type: ItemType.FEE,
      unit: 'ea',
      cost: 0,
      price: 125,
      categoryId: laborCat.id,
    },
  ]

  const items = []
  for (const item of itemDefs) {
    const created = await prisma.item.create({
      data: {
        tenantId,
        sku: item.sku,
        name: item.name,
        type: item.type,
        unit: item.unit,
        defaultUnitCost: dec(item.cost),
        defaultUnitPrice: dec(item.price),
        vendorId: item.vendorId,
        categoryId: item.categoryId,
        tags: [DEMO_TAG],
      },
    })
    items.push(created)
  }

  const [crown, baseboard, casing, installLabor, cabinetInstall, hinges, paint, deliveryFee] = items

  // --- Clients ---
  console.log('🏠 Seeding clients...')
  const clientDefs = [
    {
      name: 'Whitfield Residence',
      companyName: null,
      email: 'rachel.whitfield@example.com',
      phone: '(555) 310-1001',
      street: '42 Maple Drive',
      city: 'Scarsdale',
      state: 'NY',
      zip: '10583',
      contact: { firstName: 'Rachel', lastName: 'Whitfield', title: 'Homeowner' },
    },
    {
      name: 'Brooklyn Heights Renovation',
      companyName: 'BH Design Studio',
      email: 'projects@bhdesign.example',
      phone: '(555) 310-1002',
      street: '88 Pierrepont Street',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11201',
      contact: { firstName: 'Daniel', lastName: 'Park', title: 'Project Manager' },
    },
    {
      name: 'Greenwich Custom Home',
      companyName: null,
      email: 'tom.green@example.com',
      phone: '(555) 310-1003',
      street: '15 Orchard Lane',
      city: 'Greenwich',
      state: 'CT',
      zip: '06830',
      contact: { firstName: 'Tom', lastName: 'Green', title: 'Homeowner' },
    },
    {
      name: 'Manhattan Co-op – 5th Ave',
      companyName: '5th Ave Co-op Board',
      email: 'board@5thavecoop.example',
      phone: '(555) 310-1004',
      street: '920 Fifth Avenue',
      city: 'New York',
      state: 'NY',
      zip: '10021',
      contact: { firstName: 'Elena', lastName: 'Vasquez', title: 'Building Manager' },
    },
    {
      name: 'Riverdale Kitchen & Bath',
      companyName: 'Riverdale Builders LLC',
      email: 'jobs@riverdalebuilders.example',
      phone: '(555) 310-1005',
      street: '601 West 239th Street',
      city: 'Bronx',
      state: 'NY',
      zip: '10463',
      contact: { firstName: 'Marcus', lastName: 'Reed', title: 'General Contractor' },
    },
    {
      name: 'Hoboken Loft Conversion',
      companyName: null,
      email: 'jen.loft@example.com',
      phone: '(555) 310-1006',
      street: '300 Jackson Street',
      city: 'Hoboken',
      state: 'NJ',
      zip: '07030',
      contact: { firstName: 'Jennifer', lastName: 'Loftus', title: 'Owner' },
    },
  ]

  const clients = []
  for (const c of clientDefs) {
    const client = await prisma.client.create({
      data: {
        tenantId,
        name: c.name,
        companyName: c.companyName ?? undefined,
        email: c.email,
        phone: c.phone,
        tags: [DEMO_TAG, 'residential'],
        notes: `[${DEMO_TAG}] Sample client for local development.`,
        contacts: {
          create: {
            firstName: c.contact.firstName,
            lastName: c.contact.lastName,
            email: c.email,
            phone: c.phone,
            title: c.contact.title,
            isPrimary: true,
          },
        },
        addresses: {
          create: [
            {
              type: 'billing',
              street: c.street,
              city: c.city,
              state: c.state,
              zipCode: c.zip,
              isDefault: true,
            },
            {
              type: 'job_site',
              street: c.street,
              city: c.city,
              state: c.state,
              zipCode: c.zip,
            },
          ],
        },
      },
      include: { contacts: true, addresses: true },
    })
    clients.push(client)
  }

  const [whitfield, brooklyn, greenwich, coop, riverdale, hoboken] = clients

  function clientSite(client: (typeof clients)[number]) {
    const addr = client.addresses.find((a) => a.type === 'job_site') ?? client.addresses[0]
    return addr ?? { street: '123 Main St', city: 'New York', state: 'NY', zipCode: '10001' }
  }

  // --- Leads (Requests) ---
  console.log('📋 Seeding leads / requests...')
  const leadDefs = [
    {
      firstName: 'Amanda',
      lastName: 'Foster',
      email: 'amanda.foster@example.com',
      phone: '(555) 320-2001',
      company: null,
      source: LeadSource.WEBSITE,
      status: LeadStatus.NEW,
      value: 8500,
      jobSite: '18 Oak Street, White Plains, NY 10601',
      notes: `[${DEMO_TAG}] Wants whole-house crown and base in new construction.`,
      urgent: true,
    },
    {
      firstName: 'Robert',
      lastName: 'Klein',
      email: 'robert.klein@example.com',
      phone: '(555) 320-2002',
      company: 'Klein Properties',
      source: LeadSource.REFERRAL,
      status: LeadStatus.QUALIFIED,
      value: 22000,
      jobSite: '200 Park Avenue South, New York, NY 10003',
      notes: `[${DEMO_TAG}] Multi-unit trim package – 4 apartments.`,
      urgent: false,
    },
    {
      firstName: 'Lisa',
      lastName: 'Nguyen',
      email: 'lisa.nguyen@example.com',
      phone: '(555) 320-2003',
      company: null,
      source: LeadSource.PHONE,
      status: LeadStatus.ESTIMATE_SENT,
      value: 12500,
      jobSite: '55 Summit Ave, Montclair, NJ 07042',
      notes: `[${DEMO_TAG}] Kitchen cabinet install + crown upgrade.`,
      urgent: false,
    },
    {
      firstName: 'David',
      lastName: 'Morales',
      email: 'david.morales@example.com',
      phone: '(555) 320-2004',
      company: null,
      source: LeadSource.REFERRAL,
      status: LeadStatus.CONVERTED,
      value: 18750,
      jobSite: `${clientSite(whitfield).street}, ${clientSite(whitfield).city}, ${clientSite(whitfield).state}`,
      notes: `[${DEMO_TAG}] Converted to Whitfield Residence job.`,
      urgent: false,
      convertedToClientId: whitfield.id,
      convertedAt: daysAgo(14),
    },
    {
      firstName: 'Patricia',
      lastName: 'Shaw',
      email: 'patricia.shaw@example.com',
      phone: '(555) 320-2005',
      company: null,
      source: LeadSource.EMAIL,
      status: LeadStatus.FOLLOW_UP,
      value: 6200,
      jobSite: '14 Cedar Road, Stamford, CT 06902',
      notes: `[${DEMO_TAG}] Follow up after initial site visit.`,
      urgent: false,
    },
  ]

  const leads = []
  for (const l of leadDefs) {
    const lead = await prisma.lead.create({
      data: {
        tenantId,
        firstName: l.firstName,
        lastName: l.lastName,
        email: l.email,
        phone: l.phone,
        company: l.company ?? undefined,
        source: l.source,
        status: l.status,
        value: dec(l.value),
        probability: l.status === LeadStatus.NEW ? 30 : l.status === LeadStatus.CONVERTED ? 100 : 60,
        jobSiteAddress: l.jobSite,
        notes: l.notes,
        isUrgent: l.urgent,
        urgentAt: l.urgent ? daysAgo(1) : undefined,
        urgentByUserId: l.urgent ? users.admin.id : undefined,
        convertedToClientId: l.convertedToClientId,
        convertedAt: l.convertedAt,
        assignedToId: users.sales.id,
        createdByUserId: users.admin.id,
      },
    })
    leads.push(lead)
  }

  const [leadAmanda, leadRobert, leadLisa, leadDavid] = leads

  // --- Jobs ---
  console.log('🔨 Seeding jobs...')
  const jobDefs = [
    {
      num: 1,
      client: whitfield,
      title: 'Whole-home crown & base – Phase 1',
      status: JobStatus.IN_PROGRESS,
      priority: 2,
      estimateAmount: 18750,
      scheduledStart: daysAgo(7),
      scheduledEnd: daysFromNow(5),
      actualStart: daysAgo(6),
      leadId: leadDavid.id,
    },
    {
      num: 2,
      client: brooklyn,
      title: 'Historic brownstone trim restoration',
      status: JobStatus.SCHEDULED,
      priority: 2,
      estimateAmount: 34200,
      scheduledStart: daysFromNow(3),
      scheduledEnd: daysFromNow(10),
    },
    {
      num: 3,
      client: greenwich,
      title: 'Library built-ins & wainscoting',
      status: JobStatus.QUOTE,
      priority: 3,
      estimateAmount: 28500,
    },
    {
      num: 4,
      client: coop,
      title: 'Common hallway panel molding',
      status: JobStatus.COMPLETED,
      priority: 4,
      estimateAmount: 9800,
      scheduledStart: daysAgo(30),
      scheduledEnd: daysAgo(20),
      actualStart: daysAgo(29),
      actualEnd: daysAgo(21),
    },
    {
      num: 5,
      client: riverdale,
      title: 'Kitchen cabinet install – 24 units',
      status: JobStatus.INSTALLATION_COMPLETE,
      priority: 2,
      estimateAmount: 45600,
      scheduledStart: daysAgo(14),
      scheduledEnd: daysAgo(2),
      actualStart: daysAgo(13),
    },
    {
      num: 6,
      client: hoboken,
      title: 'Loft ceiling beams & trim package',
      status: JobStatus.INVOICED,
      priority: 3,
      estimateAmount: 16400,
      actualAmount: 16400,
      scheduledStart: daysAgo(45),
      scheduledEnd: daysAgo(30),
      actualStart: daysAgo(44),
      actualEnd: daysAgo(28),
    },
  ]

  const jobs = []
  for (const j of jobDefs) {
    const jobNumber = `JOB-${DOC_PREFIX}${String(j.num).padStart(3, '0')}`
    const job = await prisma.job.create({
      data: {
        tenantId,
        clientId: j.client.id,
        jobNumber,
        title: j.title,
        description: `[${DEMO_TAG}] ${j.title}`,
        status: j.status,
        priority: j.priority,
        estimateAmount: dec(j.estimateAmount),
        actualAmount: j.actualAmount ? dec(j.actualAmount) : undefined,
        scheduledStart: j.scheduledStart,
        scheduledEnd: j.scheduledEnd,
        actualStart: j.actualStart,
        actualEnd: j.actualEnd,
        addresses: {
          create: {
            type: 'job_site',
            street: clientSite(j.client).street,
            city: clientSite(j.client).city,
            state: clientSite(j.client).state,
            zipCode: clientSite(j.client).zipCode,
          },
        },
        assignments: {
          create: [{ userId: users.tech.id, role: 'crew_lead' }],
        },
      },
    })
    jobs.push({ ...job, leadId: j.leadId })
  }

  const [jobWhitfield, jobBrooklyn, jobGreenwich, jobCoop, jobRiverdale, jobHoboken] = jobs

  // --- Estimates ---
  console.log('📝 Seeding estimates...')
  type LineDef = { item: typeof crown; qty: number; desc?: string }

  function buildEstimateLines(lineDefs: LineDef[]) {
    return lineDefs.map((l, i) => {
      const qty = l.qty
      const unitPrice = Number(l.item.defaultUnitPrice)
      const unitCost = Number(l.item.defaultUnitCost ?? 0)
      const total = qty * unitPrice
      return {
        sourceItemId: l.item.id,
        description: l.desc ?? l.item.name,
        quantity: dec(qty),
        unitPrice: dec(unitPrice),
        unitCost: dec(unitCost),
        total: dec(total),
        sortOrder: i,
        vendorId: l.item.vendorId ?? undefined,
      }
    })
  }

  function estimateTotals(lines: ReturnType<typeof buildEstimateLines>) {
    const subtotal = lines.reduce((s, l) => s + Number(l.total), 0)
    const taxRate = 0.08875
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100
    const total = Math.round((subtotal + taxAmount) * 100) / 100
    return { subtotal, taxRate, taxAmount, total }
  }

  const estimateDefs = [
    {
      num: 1,
      client: whitfield,
      lead: leadDavid,
      job: jobWhitfield,
      title: 'Whitfield – Crown & Base Estimate',
      status: EstimateStatus.ACCEPTED,
      lines: buildEstimateLines([
        { item: crown, qty: 420 },
        { item: baseboard, qty: 380 },
        { item: casing, qty: 180 },
        { item: installLabor, qty: 48 },
        { item: deliveryFee, qty: 1 },
      ]),
      sentAt: daysAgo(20),
      acceptedAt: daysAgo(15),
    },
    {
      num: 2,
      client: brooklyn,
      lead: leadRobert,
      job: jobBrooklyn,
      title: 'BH Design – Brownstone Trim Package',
      status: EstimateStatus.SENT,
      lines: buildEstimateLines([
        { item: crown, qty: 680 },
        { item: baseboard, qty: 520 },
        { item: casing, qty: 340 },
        { item: installLabor, qty: 96 },
        { item: paint, qty: 12 },
      ]),
      sentAt: daysAgo(5),
    },
    {
      num: 3,
      client: greenwich,
      job: jobGreenwich,
      title: 'Greenwich Library Built-ins',
      status: EstimateStatus.DRAFT,
      lines: buildEstimateLines([
        { item: cabinetInstall, qty: 4 },
        { item: crown, qty: 120 },
        { item: installLabor, qty: 64 },
      ]),
    },
    {
      num: 4,
      client: coop,
      job: jobCoop,
      title: '5th Ave Co-op – Hallway Panel Molding',
      status: EstimateStatus.CONVERTED,
      lines: buildEstimateLines([
        { item: crown, qty: 85 },
        { item: baseboard, qty: 60 },
        { item: installLabor, qty: 24 },
      ]),
      sentAt: daysAgo(45),
      acceptedAt: daysAgo(40),
    },
    {
      num: 5,
      client: riverdale,
      lead: leadLisa,
      job: jobRiverdale,
      title: 'Riverdale Kitchen – Cabinets & Trim',
      status: EstimateStatus.ACCEPTED,
      lines: buildEstimateLines([
        { item: cabinetInstall, qty: 24 },
        { item: hinges, qty: 48 },
        { item: crown, qty: 95 },
        { item: installLabor, qty: 80 },
      ]),
      sentAt: daysAgo(25),
      acceptedAt: daysAgo(18),
    },
    {
      num: 6,
      client: hoboken,
      job: jobHoboken,
      title: 'Hoboken Loft – Beams & Trim',
      status: EstimateStatus.CONVERTED,
      lines: buildEstimateLines([
        { item: crown, qty: 210 },
        { item: baseboard, qty: 165 },
        { item: installLabor, qty: 56 },
        { item: paint, qty: 4 },
      ]),
      sentAt: daysAgo(60),
      acceptedAt: daysAgo(55),
    },
  ]

  const estimates = []
  for (const e of estimateDefs) {
    const estimateNumber = `EST-${DOC_PREFIX}${String(e.num).padStart(3, '0')}`
    const totals = estimateTotals(e.lines)
    const estimate = await prisma.estimate.create({
      data: {
        tenantId,
        clientId: e.client.id,
        leadId: e.lead?.id,
        jobId: e.job.id,
        estimateNumber,
        title: e.title,
        status: e.status,
        subtotal: dec(totals.subtotal),
        taxRate: dec(totals.taxRate),
        taxAmount: dec(totals.taxAmount),
        total: dec(totals.total),
        validUntil: daysFromNow(30),
        sentAt: e.sentAt,
        acceptedAt: e.acceptedAt,
        notes: `[${DEMO_TAG}] Valid for 30 days. Materials subject to availability.`,
        createdById: users.sales.id,
        lineItems: { create: e.lines },
      },
    })
    estimates.push(estimate)
  }

  const [estWhitfield, , , estCoop, estRiverdale, estHoboken] = estimates

  // --- Invoices ---
  console.log('💰 Seeding invoices...')
  const invoiceDefs = [
    {
      num: 1,
      client: coop,
      job: jobCoop,
      estimate: estCoop,
      title: '5th Ave Co-op – Final Invoice',
      status: InvoiceStatus.PAID,
      paidFraction: 1,
      lines: buildEstimateLines([
        { item: crown, qty: 85 },
        { item: baseboard, qty: 60 },
        { item: installLabor, qty: 24 },
      ]),
      invoiceDate: daysAgo(18),
      dueDate: daysAgo(3),
      sentAt: daysAgo(18),
      paidAt: daysAgo(5),
    },
    {
      num: 2,
      client: whitfield,
      job: jobWhitfield,
      estimate: estWhitfield,
      title: 'Whitfield – 50% Progress Invoice',
      status: InvoiceStatus.PARTIAL,
      paidFraction: 0.5,
      lines: buildEstimateLines([
        { item: crown, qty: 210 },
        { item: baseboard, qty: 190 },
        { item: installLabor, qty: 24 },
      ]),
      invoiceDate: daysAgo(3),
      dueDate: daysFromNow(27),
      sentAt: daysAgo(3),
    },
    {
      num: 3,
      client: riverdale,
      job: jobRiverdale,
      estimate: estRiverdale,
      title: 'Riverdale Kitchen – Deposit Invoice',
      status: InvoiceStatus.SENT,
      paidFraction: 0,
      lines: buildEstimateLines([
        { item: cabinetInstall, qty: 24 },
        { item: hinges, qty: 48 },
      ]),
      invoiceDate: daysAgo(10),
      dueDate: daysFromNow(20),
      sentAt: daysAgo(10),
    },
    {
      num: 4,
      client: hoboken,
      job: jobHoboken,
      estimate: estHoboken,
      title: 'Hoboken Loft – Final Invoice',
      status: InvoiceStatus.OVERDUE,
      paidFraction: 0,
      lines: buildEstimateLines([
        { item: crown, qty: 210 },
        { item: baseboard, qty: 165 },
        { item: installLabor, qty: 56 },
        { item: paint, qty: 4 },
      ]),
      invoiceDate: daysAgo(25),
      dueDate: daysAgo(5),
      sentAt: daysAgo(25),
    },
    {
      num: 5,
      client: brooklyn,
      job: jobBrooklyn,
      estimate: null,
      title: 'BH Design – Design Consultation Fee',
      status: InvoiceStatus.DRAFT,
      paidFraction: 0,
      lines: buildEstimateLines([{ item: installLabor, qty: 2, desc: 'On-site design consultation' }]),
      invoiceDate: new Date(),
      dueDate: daysFromNow(14),
    },
  ]

  const invoices = []
  for (const inv of invoiceDefs) {
    const invoiceNumber = `INV-${DOC_PREFIX}${String(inv.num).padStart(3, '0')}`
    const totals = estimateTotals(inv.lines)
    const paidAmount = Math.round(totals.total * inv.paidFraction * 100) / 100
    const balance = Math.round((totals.total - paidAmount) * 100) / 100
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        clientId: inv.client.id,
        jobId: inv.job.id,
        estimateId: inv.estimate?.id,
        invoiceNumber,
        title: inv.title,
        status: inv.status,
        subtotal: dec(totals.subtotal),
        taxRate: dec(totals.taxRate),
        taxAmount: dec(totals.taxAmount),
        total: dec(totals.total),
        paidAmount: dec(paidAmount),
        balance: dec(balance),
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        sentAt: inv.sentAt,
        paidAt: inv.paidAt,
        notes: `[${DEMO_TAG}] Thank you for your business.`,
        lineItems: { create: inv.lines },
        ...(paidAmount > 0
          ? {
              payments: {
                create: {
                  amount: dec(paidAmount),
                  status: PaymentStatus.COMPLETED,
                  method: PaymentMethod.CHECK,
                  reference: `DEMO-PAY-${inv.num}`,
                  processedAt: inv.paidAt ?? daysAgo(5),
                  notes: `[${DEMO_TAG}] Demo payment`,
                },
              },
            }
          : {}),
      },
    })
    invoices.push(invoice)
  }

  // --- Purchase Orders ---
  console.log('🛒 Seeding purchase orders...')
  const poDefs = [
    {
      num: 1,
      vendor: lumberVendor,
      client: whitfield,
      job: jobWhitfield,
      status: PurchaseOrderStatus.ORDERED,
      lines: [
        { item: crown, qty: 450, cost: 4.25 },
        { item: baseboard, qty: 400, cost: 3.1 },
        { item: casing, qty: 200, cost: 2.85 },
      ],
      orderDate: daysAgo(8),
      expectedDate: daysFromNow(2),
    },
    {
      num: 2,
      vendor: hardwareVendor,
      client: riverdale,
      job: jobRiverdale,
      status: PurchaseOrderStatus.RECEIVED,
      lines: [{ item: hinges, qty: 60, cost: 6.5 }],
      orderDate: daysAgo(20),
      expectedDate: daysAgo(12),
      receivedDate: daysAgo(11),
    },
    {
      num: 3,
      vendor: finishVendor,
      client: brooklyn,
      job: jobBrooklyn,
      status: PurchaseOrderStatus.APPROVED,
      lines: [{ item: paint, qty: 15, cost: 38 }],
      orderDate: daysAgo(2),
      expectedDate: daysFromNow(5),
    },
    {
      num: 4,
      vendor: lumberVendor,
      client: greenwich,
      job: jobGreenwich,
      status: PurchaseOrderStatus.DRAFT,
      lines: [
        { item: crown, qty: 150, cost: 4.25 },
        { item: baseboard, qty: 120, cost: 3.1 },
      ],
      orderDate: new Date(),
      expectedDate: daysFromNow(10),
    },
  ]

  for (const po of poDefs) {
    const poNumber = `PO-${DOC_PREFIX}${String(po.num).padStart(3, '0')}`
    const lineRows = po.lines.map((l, i) => {
      const total = l.qty * l.cost
      return {
        sourceItemId: l.item.id,
        description: l.item.name,
        quantity: dec(l.qty),
        unitPrice: dec(l.cost),
        unitCost: dec(l.cost),
        total: dec(total),
        sortOrder: i,
        vendorId: po.vendor.id,
      }
    })
    const total = lineRows.reduce((s, l) => s + Number(l.total), 0)
    await prisma.purchaseOrder.create({
      data: {
        tenantId,
        clientId: po.client.id,
        jobId: po.job.id,
        poNumber,
        vendor: po.vendor.name,
        vendorId: po.vendor.id,
        status: po.status,
        total: dec(total),
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        receivedDate: po.receivedDate,
        lineItems: { create: lineRows },
      },
    })
  }

  // --- Schedules ---
  console.log('📅 Seeding schedules...')
  const today = new Date()
  const scheduleDefs = [
    {
      title: 'Whitfield – Crown install Day 2',
      type: ScheduleType.JOB,
      job: jobWhitfield,
      user: users.tech,
      start: atTime(today, 8, 0),
      end: atTime(today, 16, 0),
    },
    {
      title: 'Whitfield – Crown install Day 3',
      type: ScheduleType.JOB,
      job: jobWhitfield,
      user: users.tech,
      start: atTime(daysFromNow(1), 8, 0),
      end: atTime(daysFromNow(1), 16, 0),
    },
    {
      title: 'Brooklyn brownstone – Site prep',
      type: ScheduleType.JOB,
      job: jobBrooklyn,
      user: users.tech,
      start: atTime(daysFromNow(3), 7, 30),
      end: atTime(daysFromNow(3), 12, 0),
    },
    {
      title: 'Riverdale – Cabinet delivery coordination',
      type: ScheduleType.JOB,
      job: jobRiverdale,
      user: users.dispatcher,
      start: atTime(daysFromNow(2), 10, 0),
      end: atTime(daysFromNow(2), 11, 0),
    },
    {
      title: 'Site visit – Amanda Foster lead',
      type: ScheduleType.ESTIMATE,
      lead: leadAmanda,
      user: users.sales,
      start: atTime(daysFromNow(1), 14, 0),
      end: atTime(daysFromNow(1), 15, 30),
    },
    {
      title: 'Follow-up call – Robert Klein',
      type: ScheduleType.FOLLOW_UP,
      lead: leadRobert,
      user: users.sales,
      start: atTime(daysFromNow(2), 9, 0),
      end: atTime(daysFromNow(2), 9, 30),
    },
    {
      title: 'Greenwich – Measure library built-ins',
      type: ScheduleType.ESTIMATE,
      job: jobGreenwich,
      user: users.tech,
      start: atTime(daysFromNow(4), 13, 0),
      end: atTime(daysFromNow(4), 15, 0),
    },
    {
      title: 'Weekly crew meeting',
      type: ScheduleType.MEETING,
      user: users.dispatcher,
      start: atTime(daysFromNow(5), 7, 0),
      end: atTime(daysFromNow(5), 7, 45),
    },
  ]

  for (const s of scheduleDefs) {
    await prisma.schedule.create({
      data: {
        tenantId,
        title: s.title,
        description: `[${DEMO_TAG}]`,
        type: s.type,
        startTime: s.start,
        endTime: s.end,
        jobId: s.job?.id,
        leadId: s.lead?.id,
        userId: s.user.id,
      },
    })
  }

  // --- Messages / Conversations ---
  console.log('💬 Seeding message conversations...')
  const convoDefs = [
    {
      client: whitfield,
      job: jobWhitfield,
      phone: whitfield.phone!,
      messages: [
        {
          direction: MessageDirection.INBOUND,
          body: 'Hi, just checking what time the crew arrives tomorrow?',
          hoursAgo: 26,
        },
        {
          direction: MessageDirection.OUTBOUND,
          body: 'Good morning Rachel! Mike and the crew will be there between 8–8:30 AM.',
          hoursAgo: 25,
        },
        {
          direction: MessageDirection.INBOUND,
          body: 'Perfect, thank you!',
          hoursAgo: 24,
        },
      ],
    },
    {
      client: brooklyn,
      job: jobBrooklyn,
      phone: brooklyn.phone!,
      messages: [
        {
          direction: MessageDirection.OUTBOUND,
          body: 'Hi Daniel – your brownstone estimate is ready. Total is $37,200. Let me know if you have questions.',
          hoursAgo: 120,
        },
        {
          direction: MessageDirection.INBOUND,
          body: 'Thanks Sarah. Can we schedule a walkthrough before we approve?',
          hoursAgo: 96,
        },
        {
          direction: MessageDirection.OUTBOUND,
          body: 'Absolutely – I have Thursday at 2 PM or Friday at 10 AM. Which works?',
          hoursAgo: 95,
        },
      ],
    },
    {
      client: riverdale,
      job: jobRiverdale,
      phone: riverdale.phone!,
      messages: [
        {
          direction: MessageDirection.INBOUND,
          body: 'Marcus here – hinges arrived. When can your team finish the cabinet install?',
          hoursAgo: 48,
        },
        {
          direction: MessageDirection.OUTBOUND,
          body: 'Great news! Mike is scheduled Thursday morning to complete the remaining 6 units.',
          hoursAgo: 47,
        },
      ],
    },
    {
      client: hoboken,
      job: jobHoboken,
      phone: hoboken.phone!,
      messages: [
        {
          direction: MessageDirection.OUTBOUND,
          body: 'Hi Jennifer – friendly reminder that invoice INV-900004 is past due. Happy to discuss payment options.',
          hoursAgo: 72,
        },
        {
          direction: MessageDirection.INBOUND,
          body: 'Sorry for the delay – check is going out this week.',
          hoursAgo: 48,
        },
      ],
    },
  ]

  const companyPhone = '(555) 100-0001'

  for (const c of convoDefs) {
    const lastMsg = c.messages[c.messages.length - 1]
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        channel: MessageChannel.SMS,
        clientId: c.client.id,
        jobId: c.job.id,
        assignedUserId: users.sales.id,
        participants: [companyPhone, c.phone],
        status: ConversationStatus.ACTIVE,
        lastMessageAt: new Date(Date.now() - lastMsg.hoursAgo * 3600000),
        metadata: { [DEMO_TAG]: true },
      },
    })

    for (const m of c.messages) {
      const createdAt = new Date(Date.now() - m.hoursAgo * 3600000)
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          direction: m.direction,
          channel: MessageChannel.SMS,
          body: m.body,
          fromNumber: m.direction === MessageDirection.INBOUND ? c.phone : companyPhone,
          toNumber: m.direction === MessageDirection.INBOUND ? companyPhone : c.phone,
          provider: 'demo',
          providerMessageId: `demo-${conversation.id}-${m.hoursAgo}`,
          status: MessageStatus.DELIVERED,
          sentAt: createdAt,
          deliveredAt: createdAt,
          createdAt,
        },
      })
    }
  }

  return {
    vendors: vendors.length,
    items: items.length,
    clients: clients.length,
    leads: leads.length,
    jobs: jobs.length,
    estimates: estimates.length,
    invoices: invoices.length,
    purchaseOrders: poDefs.length,
    schedules: scheduleDefs.length,
    conversations: convoDefs.length,
    messages: convoDefs.reduce((n, c) => n + c.messages.length, 0),
  }
}

async function main() {
  console.log('🌱 Trim Pro dev demo seed')
  console.log('')

  const admin = await prisma.user.findFirst({
    where: { email: 'admin@trimpro.com' },
  })

  if (!admin) {
    console.error('❌ admin@trimpro.com not found. Run: npm run db:seed')
    process.exit(1)
  }

  const tenantId = admin.tenantId
  console.log(`🏢 Tenant: ${tenantId}`)
  console.log(`👤 Admin: ${admin.email}`)
  console.log('')

  await clearDemoData(tenantId)
  const counts = await seedDemoData(tenantId, admin.id)

  console.log('')
  console.log('✅ Demo seed complete!')
  console.log('')
  console.log('📊 Seeded counts:')
  console.log(`   Vendors:          ${counts.vendors}`)
  console.log(`   Items:            ${counts.items}`)
  console.log(`   Clients:          ${counts.clients}`)
  console.log(`   Leads/Requests:   ${counts.leads}`)
  console.log(`   Jobs:             ${counts.jobs}`)
  console.log(`   Estimates:        ${counts.estimates}`)
  console.log(`   Invoices:         ${counts.invoices}`)
  console.log(`   Purchase Orders:  ${counts.purchaseOrders}`)
  console.log(`   Schedules:        ${counts.schedules}`)
  console.log(`   Conversations:    ${counts.conversations}`)
  console.log(`   Messages:         ${counts.messages}`)
  console.log('')
  console.log('🔑 Login: admin@trimpro.com / admin123')
  console.log('   Demo team: mike.tech@trimpro.com, sarah.sales@trimpro.com (password: demo123)')
  console.log('')
  console.log('🔄 Re-run: npx tsx scripts/seed-dev-demo.ts')
}

main()
  .catch((e) => {
    console.error('❌ Demo seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
