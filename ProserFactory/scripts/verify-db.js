const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRawUnsafe("SHOW TABLES LIKE 'images'");
    console.log('tables:', JSON.stringify(tables));
    const cols = await prisma.$queryRawUnsafe("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('books','acts','chapters','scenes') AND COLUMN_NAME='selected_image_id'");
    console.log('columns:', JSON.stringify(cols));
    if (tables.length) {
      const describe = await prisma.$queryRawUnsafe('DESCRIBE images');
      console.log('describe images:', JSON.stringify(describe));
    }
  } catch (e) {
    console.error('verify error:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
