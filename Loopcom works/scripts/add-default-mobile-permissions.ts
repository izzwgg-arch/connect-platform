/**
 * Script to add default mobile permissions to existing roles
 * Run with: npx tsx scripts/add-default-mobile-permissions.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const mobileInfoPerms = [
  'mobile.jobs.view_financials',
  'mobile.jobs.view_documents',
  'mobile.jobs.view_billing',
  'mobile.jobs.view_time_entries',
  'mobile.jobs.view_notes',
  'mobile.jobs.view_crew',
  'mobile.jobs.view_schedules',
  'mobile.jobs.view_client_details',
  'mobile.jobs.view_tasks_issues',
  'mobile.requests.view',
  'mobile.requests.create',
  'mobile.requests.edit',
  'mobile.requests.assign',
  'mobile.requests.view_financials',
  'mobile.requests.view_estimates',
  'mobile.requests.view_communication',
  'mobile.requests.view_activity',
  'mobile.requests.view_tasks_issues',
  'mobile.requests.view_converted_client',
]

const mobilePermissionsByRole: Record<string, string[]> = {
  Owner: [
    'mobile.access',
    'mobile.jobs.view_all',
    'mobile.schedule.view_all',
    'mobile.jobs.assign',
    'canCreateSchedulesForOthers',
    'mobile.jobs.complete',
    'mobile.tasks.create',
    'mobile.tasks.assign_to_any',
    'mobile.issues.create',
    'mobile.issues.assign_to_any',
    'mobile.messaging.enabled',
    'mobile.media.upload',
    ...mobileInfoPerms,
  ],
  Admin: [
    'mobile.access',
    'mobile.jobs.view_all',
    'mobile.schedule.view_all',
    'mobile.jobs.assign',
    'canCreateSchedulesForOthers',
    'mobile.jobs.complete',
    'mobile.tasks.create',
    'mobile.tasks.assign_to_any',
    'mobile.issues.create',
    'mobile.issues.assign_to_any',
    'mobile.messaging.enabled',
    'mobile.media.upload',
    ...mobileInfoPerms,
  ],
  Manager: [
    'mobile.access',
    'mobile.jobs.view_all',
    'mobile.schedule.view_all',
    'mobile.jobs.assign',
    'mobile.jobs.complete',
    'mobile.tasks.create',
    'mobile.tasks.assign_to_any',
    'mobile.issues.create',
    'mobile.issues.assign_to_any',
    'mobile.messaging.enabled',
    'mobile.media.upload',
    ...mobileInfoPerms,
  ],
  Dispatcher: [
    'mobile.access',
    'mobile.jobs.view_all',
    'mobile.schedule.view_all',
    'mobile.jobs.assign',
    'mobile.jobs.complete',
    'mobile.tasks.create',
    'mobile.tasks.assign_to_any',
    'mobile.issues.create',
    'mobile.issues.assign_to_any',
    'mobile.messaging.enabled',
    'mobile.media.upload',
    ...mobileInfoPerms,
  ],
  Tech: [
    'mobile.access',
    'mobile.jobs.view_assigned',
    'mobile.jobs.complete',
    'mobile.tasks.create',
    'mobile.tasks.assign_to_admin',
    'mobile.issues.create',
    'mobile.issues.assign_to_admin',
    'mobile.messaging.enabled',
    'mobile.media.upload',
    'mobile.jobs.view_billing',
    'mobile.jobs.view_time_entries',
    'mobile.jobs.view_notes',
    'mobile.jobs.view_crew',
    'mobile.jobs.view_schedules',
    'mobile.jobs.view_client_details',
    'mobile.jobs.view_tasks_issues',
    'mobile.requests.view',
    'mobile.requests.view_activity',
    'mobile.requests.view_tasks_issues',
  ],
  Accounting: [
    'mobile.access',
    'mobile.jobs.view_assigned',
    'mobile.messaging.enabled',
    'mobile.jobs.view_financials',
    'mobile.jobs.view_documents',
    'mobile.jobs.view_billing',
    'mobile.jobs.view_client_details',
    'mobile.requests.view',
    'mobile.requests.view_financials',
    'mobile.requests.view_estimates',
    'mobile.requests.view_converted_client',
  ],
  ReadOnly: [
    'mobile.access',
    'mobile.jobs.view_assigned',
    'mobile.jobs.view_notes',
    'mobile.jobs.view_tasks_issues',
    'mobile.requests.view',
  ],
}

async function main() {
  console.log('🔄 Adding default mobile permissions to existing roles...')

  const tenants = await prisma.tenant.findMany()

  for (const tenant of tenants) {
    console.log(`\n📦 Processing tenant: ${tenant.name}`)

    const roles = await prisma.role.findMany({
      where: { tenantId: tenant.id },
    })

    for (const role of roles) {
      const defaultPerms = mobilePermissionsByRole[role.name] || ['mobile.access']
      const currentPerms = Array.isArray(role.mobilePermissions) ? (role.mobilePermissions as string[]) : []

      // Merge with existing permissions (don't remove existing grants)
      const mergedPerms = [...new Set([...currentPerms, ...defaultPerms])]

      if (JSON.stringify(mergedPerms.sort()) !== JSON.stringify([...currentPerms].sort())) {
        await prisma.role.update({
          where: { id: role.id },
          data: { mobilePermissions: mergedPerms },
        })
        console.log(`   ✅ Updated role "${role.name}": ${mergedPerms.length} mobile permissions`)
      } else {
        console.log(`   ⏭️  Role "${role.name}" already has mobile permissions`)
      }
    }
  }

  console.log('\n✅ Done!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
