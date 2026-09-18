import { prisma } from '../lib/prisma'
import { PERMISSIONS } from '../lib/permissions-catalog'

async function main() {
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: {
        label: perm.label,
        description: perm.description,
        category: perm.category,
        module: perm.module,
      },
      create: {
        key: perm.key,
        label: perm.label,
        description: perm.description,
        category: perm.category,
        module: perm.module,
      },
    })
  }
  console.log(`Synced ${PERMISSIONS.length} permissions`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
