// Uso: npm run set-plan -- correo@ejemplo.com pro
// Cambia el plan de un usuario a mano (útil para pruebas o pagos fuera de Stripe).
// Necesita DATABASE_URL apuntando a la misma base que usa el servidor.
const db = require('../src/db');
const { PLANS } = require('../src/plans');

(async () => {
  const [email, plan] = process.argv.slice(2);
  if (!email || !PLANS[plan]) {
    console.log('Uso: npm run set-plan -- correo@ejemplo.com <free|pro>');
    process.exit(1);
  }
  await db.init();
  const user = await db.getUserByEmail(email.toLowerCase());
  if (!user) {
    console.log('No existe un usuario con ese correo.');
    process.exit(1);
  }
  await db.setPlan(user.id, plan);
  console.log(`${email} ahora tiene el plan ${plan}. (Si el servidor está corriendo, recarga el panel.)`);
  await db.close();
})();
