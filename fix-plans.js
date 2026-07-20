const { db } = require("./server/db/database");
db.prepare(
  "UPDATE plans SET max_devices=-1, max_storage_mb=-1, remote_control=1, remote_url=1, priority_support=1",
).run();
console.log("all plans updated to unlimited");
console.log(db.prepare("SELECT * FROM plans").all());
