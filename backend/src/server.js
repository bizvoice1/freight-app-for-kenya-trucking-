import "dotenv/config";
import { app } from "./app.js";

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Behari Freight backend listening on http://localhost:${PORT}`));
