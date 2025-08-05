// 파일: index.js (최종 아키텍처 수정본)

const express = require('express');
const { CloudTasksClient } = require('@google-cloud/tasks');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const { createResponseFormat, createCallbackWaitResponse } = require('./utils.js');
const { SYSTEM_PROMPT_HEALTH_CONSULT, SYSTEM_PROMPT_WAIT_MESSAGE } = require('./prompt.js');

const app = express();
app.use(express.json());
const tasksClient = new CloudTasksClient();

// 환경 변수
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT;
const GCP_LOCATION = process.env.GCP_LOCATION;
const TASK_QUEUE_NAME = process.env.TASK_QUEUE_NAME;
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL;

// --- 대기 메시지 생성 함수 ---
async function callGeminiForWaitMessage(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-1.5-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // 타임아웃 4초

    try {
        const body = {
            contents: [ { role: 'user', parts: [{ text: SYSTEM_PROMPT_WAIT_MESSAGE }] }, { role: 'model', parts: [{ text: "{\"wait_text\": \"네, 안녕하세요! 질문을 확인하고 있어요.\"}" }] }, { role: 'user', parts: [{ text: userInput }] } ],
            generationConfig: { temperature: 0.5 },
        };
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw new Error(`Gemini WaitMsg Error (${response.status}): ${await response.text()}`);
        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Gemini for wait message.");
        return JSON.parse(data.candidates[0].content.parts[0].text).wait_text;
    } catch (error) {
        console.error('Error generating wait message:', error.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// --- 메인 답변 생성 함수 ---
async function callGeminiForAnswer(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-1.5-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
        const body = {
            contents: [ { role: 'user', parts: [{ text: SYSTEM_PROMPT_HEALTH_CONSULT }] }, { role: 'model', parts: [{ text: "{\n  \"response_text\": \"네, 안녕하세요! Dr.LIKE입니다. 무엇을 도와드릴까요?\",\n  \"follow_up_questions\": [\n    \"아기가 열이 나요\",\n    \"신생아 예방접종 알려줘\"\n  ]\n}" }] }, { role: 'user', parts: [{ text: userInput }] } ],
            generationConfig: { temperature: 0.7 },
        };
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw new Error(`Gemini API Error (${response.status}): ${await response.text()}`);
        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Gemini for answer.");
        return JSON.parse(data.candidates[0].content.parts[0].text);
    } catch (error) {
        if (error.name === 'AbortError') { throw new Error('Gemini API call timed out after 25 seconds.'); }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// === [수정] 엔드포인트 1: 카카오 요청 접수 (AI 호출 제거) ===
app.post('/skill', async (req, res) => {
    const userInput = req.body.userRequest?.utterance;
    const callbackUrl = req.body.userRequest?.callbackUrl;
    if (!userInput || !callbackUrl) return res.status(400).json(createResponseFormat("잘못된 요청입니다.", []));
    if (!CLOUD_RUN_URL) return res.status(500).json(createResponseFormat("서버 설정 오류입니다. (URL 미설정)", []));

    const staticWaitMessage = "네, 질문을 확인했어요. AI가 답변을 열심히 준비하고 있으니 잠시만 기다려주세요! 🤖";
    const waitResponse = createCallbackWaitResponse(staticWaitMessage);
    
    try {
        const queuePath = tasksClient.queuePath(GCP_PROJECT, GCP_LOCATION, TASK_QUEUE_NAME);
        const task = { httpRequest: { httpMethod: 'POST', url: `${CLOUD_RUN_URL}/api/process-job`, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ userInput, callbackUrl })).toString('base64'), } };
        await tasksClient.createTask({ parent: queuePath, task });
        console.log('Successfully published job to Cloud Tasks.');
        return res.status(200).json(waitResponse);
    } catch (error) {
        console.error("Failed to publish job to Cloud Tasks:", error);
        return res.status(500).json(createResponseFormat("시스템 오류로 작업을 시작하지 못했어요.", []));
    }
});

// === [수정] 엔드포인트 2: Cloud Tasks 작업 처리 (2단계 콜백 수행) ===
app.post('/api/process-job', async (req, res) => {
    const { userInput, callbackUrl } = req.body;
    if (!userInput || !callbackUrl) return res.status(400).send("Invalid request.");

    res.status(200).send("Job received, processing in background.");
    
    try {
        const dynamicWaitMessage = await callGeminiForWaitMessage(userInput);
        if (dynamicWaitMessage) {
            const dynamicWaitResponse = createResponseFormat(dynamicWaitMessage, []);
            await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dynamicWaitResponse) });
            console.log('Dynamic wait message sent successfully.');
        }

        console.log(`Processing main answer for: "${userInput}"`);
        const aiResult = await callGeminiForAnswer(userInput);
        const finalResponse = createResponseFormat(aiResult.response_text, aiResult.follow_up_questions);
        await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(finalResponse) });
        console.log('Final answer sent successfully.');

    } catch (error) {
        console.error(`Error processing job for "${userInput}":`, error.message);
        const errorResponse = createResponseFormat("죄송합니다, AI 답변 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요. 😥", []);
        await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(errorResponse) }).catch(cbErr => console.error("Failed to send error callback:", cbErr.message));
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Dr.LIKE server listening on port ${PORT}`));
