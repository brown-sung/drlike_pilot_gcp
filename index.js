// 파일: index.js (안정성 강화 최종본)

const express = require('express');
const { Client } = require("@upstash/qstash");
const { createResponseFormat, createCallbackWaitResponse } = require('./utils.js');
const { SYSTEM_PROMPT_HEALTH_CONSULT, SYSTEM_PROMPT_WAIT_MESSAGE } = require('./prompt.js');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json()); 


const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const VERCEL_DEPLOYMENT_URL = process.env.VERCEL_URL;


if (!QSTASH_TOKEN) {
  throw new Error("QSTASH_TOKEN is not defined in environment variables.");
}
const qstashClient = new Client({
  token: QSTASH_TOKEN,
});

async function callGeminiForWaitMessage(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500); 

    try {
        const body = {
            contents: [
                { role: 'user', parts: [{ text: SYSTEM_PROMPT_WAIT_MESSAGE }] },
                { role: 'model', parts: [{ text: "{\"wait_text\": \"네, 안녕하세요! 질문을 확인하고 있어요.\"}" }] },
                { role: 'user', parts: [{ text: userInput }] }
            ],
            generationConfig: { temperature: 0.5, response_mime_type: "application/json" },
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`Gemini WaitMsg Error (${response.status})`);
        }
        const data = await response.json();
        
        // [안전 코드] Gemini 응답 구조 확인
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
             console.error("Invalid response structure from Gemini API for wait message:", JSON.stringify(data, null, 2));
             throw new Error("Gemini API returned an invalid or empty response for wait message.");
        }
        return JSON.parse(data.candidates[0].content.parts[0].text).wait_text;
    } catch (error) {
        if (error.name === 'AbortError') { 
            console.error('Gemini wait message generation timed out.'); 
        } else { 
            console.error('Error generating wait message:', error.message); 
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function callGeminiForAnswer(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-2.5-flash'; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); 

    try {
        const body = {
            contents: [
                { role: 'user', parts: [{ text: SYSTEM_PROMPT_HEALTH_CONSULT }] },
                { role: 'model', parts: [{ text: "{\n  \"response_text\": \"네, 안녕하세요! Dr.LIKE입니다. 무엇을 도와드릴까요?\",\n  \"follow_up_questions\": [\n    \"아기가 열이 나요\",\n    \"신생아 예방접종 알려줘\"\n  ]\n}" }] },
                { role: 'user', parts: [{ text: userInput }] }
            ],
            generationConfig: { temperature: 0.7, response_mime_type: "application/json" },
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errorBody}`);
        }
        const data = await response.json();

        // [안전 코드] Gemini 응답 구조 확인
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
            console.error("Invalid response structure from Gemini API:", JSON.stringify(data, null, 2));
            throw new Error("Gemini API returned an invalid or empty response. This could be due to safety settings or other API issues.");
        }
        
        return JSON.parse(data.candidates[0].content.parts[0].text);
    } catch (error) {
        if (error.name === 'AbortError') { throw new Error('Gemini API call timed out after 25 seconds.'); }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}


app.post('/skill', async (req, res) => {
    const userInput = req.body.userRequest?.utterance;
    const callbackUrl = req.body.userRequest?.callbackUrl;
    if (!userInput || !callbackUrl) return res.status(400).json(createResponseFormat("잘못된 요청입니다.", []));

    const defaultWaitMessage = "네, 질문을 확인했어요. AI가 답변을 열심히 준비하고 있으니 잠시만 기다려주세요! 🤖";
    let dynamicWaitMessage = null;
    
    try {
        dynamicWaitMessage = await callGeminiForWaitMessage(userInput);
    } catch(e) {
        console.error("An unexpected error occurred in wait message generation:", e);
    }
    
    const waitResponse = createCallbackWaitResponse(dynamicWaitMessage || defaultWaitMessage);

    console.log('[/skill] Received request. Publishing job to QStash...');
    try {
        await qstashClient.publishJSON({
            url: `https://${VERCEL_DEPLOYMENT_URL}/api/process-job`,
            body: { userInput, callbackUrl },
        });
        return res.json(waitResponse);
    } catch (error) {
        console.error("[/skill] Failed to publish job to QStash:", error);
        return res.status(500).json(createResponseFormat("시스템 오류로 작업을 시작하지 못했어요.", []));
    }
});


app.post('/api/process-job', async (req, res) => {
    console.log('[/api/process-job] Received job from QStash.');
    const { userInput, callbackUrl } = req.body;

    try {
        console.log(`[/api/process-job] Processing job for: "${userInput}"`);
        const aiResult = await callGeminiForAnswer(userInput);
        const finalResponse = createResponseFormat(aiResult.response_text, aiResult.follow_up_questions);
        
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalResponse),
        });

        console.log('[/api/process-job] Job processed and callback sent successfully.');
        return res.status(200).send("Job processed successfully.");

    } catch (error) {
        // [사용자 경험 개선] 에러 발생 시 사용자에게 실패 메시지 콜백 전송
        console.error(`[/api/process-job] Error processing job for "${userInput}":`, error.message);
        
        if (callbackUrl) {
            const errorResponse = createResponseFormat("죄송합니다, AI 답변 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요. 😥", []);
            await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(errorResponse),
            }).catch(callbackError => {
                console.error("[/api/process-job] Failed to send error callback:", callbackError.message);
            });
        }
        
        return res.status(500).send("Failed to process job.");
    }
});


app.get("/", (req, res) => {
    res.status(200).send("Dr.LIKE Health Consultation Bot (QStash Ready & Stable with Dynamic Wait Message) is running!");
});


module.exports = app;
