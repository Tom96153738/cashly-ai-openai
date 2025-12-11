import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// ---- CHAT ENDPOINT ---- //
app.post("/api/chat", async (req, res) => {
    const { message, userId } = req.body;

    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Du bist eine moderne hilfreiche KI." },
                    { role: "user", content: message }
                ]
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        res.json({ response: response.data.choices[0].message.content });

    } catch (err) {
        res.status(500).json({
            error: "server_error",
            details: err.response?.data || err.message
        });
    }
});

// Start Server
app.listen(3000, () => {
    console.log("🚀 Server läuft auf Port 3000");
});
