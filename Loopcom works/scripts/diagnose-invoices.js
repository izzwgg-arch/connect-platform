const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const counts = await prisma.invoice.groupBy({
    by: ['status'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } }
  });
  console.log('=== Invoice status breakdown ===');
  counts.forEach(r => console.log('  ' + r.status + ': ' + r._count.id));

  const openCt = await prisma.invoice.count({
    where: { status: { in: ['SENT','VIEWED','PARTIAL','OVERDUE'] } }
  });
  console.log('\nTotal "open" by status (SENT+VIEWED+PARTIAL+OVERDUE): ' + openCt);

  const balGt0 = await prisma.invoice.count({ where: { balance: { gt: 0 } } });
  console.log('Total with balance > 0 (any status): ' + balGt0);

  const qboLinked = await prisma.invoice.count({
    where: { qboSyncId: { not: null }, balance: { gt: 0 } }
  });
  console.log('QB-linked AND balance > 0: ' + qboLinked);

  const noQbo = await prisma.invoice.count({
    where: { qboSyncId: null, balance: { gt: 0 } }
  });
  console.log('NOT QB-linked AND balance > 0: ' + noQbo);

  // Invoices with PAID status but still balance > 0 (data integrity issue)
  const paidWithBalance = await prisma.invoice.count({
    where: { status: 'PAID', balance: { gt: 0 } }
  });
  console.log('\nPAID status but balance still > 0 (bug): ' + paidWithBalance);

  // Invoices that are "open" by status but actually have balance = 0 (should be PAID)
  const openButZeroBalance = await prisma.invoice.count({
    where: { status: { in: ['SENT','VIEWED','PARTIAL','OVERDUE'] }, balance: { lte: 0 } }
  });
  console.log('Open status but balance <= 0 (should be PAID): ' + openButZeroBalance);

  // How many QB-linked invoices total
  const totalQboLinked = await prisma.invoice.count({ where: { qboSyncId: { not: null } } });
  console.log('\nTotal QB-linked invoices (any status): ' + totalQboLinked);

  console.log('\n=== Most likely sources of extra 36 ===');
  console.log('Invoices showing as open in TrimPro but may be paid in QB:');
  const candidates = await prisma.invoice.findMany({
    where: {
      qboSyncId: { not: null },
      balance: { gt: 0 },
      status: { in: ['SENT','VIEWED','PARTIAL','OVERDUE'] }
    },
    select: { invoiceNumber: true, balance: true, total: true, status: true, qboSyncId: true },
    orderBy: { balance: 'desc' },
    take: 10
  });
  candidates.forEach(i => {
    console.log('  #' + i.invoiceNumber + ' status=' + i.status + ' balance=$' + Number(i.balance).toFixed(2) + ' total=$' + Number(i.total).toFixed(2) + ' qboId=' + i.qboSyncId);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
