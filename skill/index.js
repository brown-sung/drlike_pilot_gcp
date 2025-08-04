// 파일: skill/index.js

const functions = require('@google-cloud/functions-framework');
const { CloudTasksClient } = require('@google-cloud/tasks');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const { createResponseFormat, createCallbackWaitResponse } = require('../common/utils.js');
const { SYSTEM_PROMPT_WAIT_MESSAGE } = require('../common/prompt.js');

const tasksClient = new CloudTasksClient();

// 환경 변수 (Cloud Build에서 주입)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT;
const GCP_LOCATION = process.env.GCP_LOCATION;
const TASK_QUEUE_NAME = process.env.TASK_QUEUE_NAME;
const PROCESS_JOB_FUNCTION_URL = process.env.PROCESS_JOB_FUNCTION_URL;

async function callGeminiForWaitMessage(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-1.5-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok) throw new Error(`Gemini WaitMsg Error (${response.status})`);
        
        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
             throw new Error("Gemini API returned an invalid response for wait message.");
        }
        return JSON.parse(data.candidates[0].content.parts[0].text).wait_text;
    } catch (error) {
        console.error('Error generating wait message:', error.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

functions.http('skillGcp', async (req, res) => {
    const userInput = req.body.userRequest?.utterance;
    const callbackUrl = req.body.userRequest?.callbackUrl;
    if (!userInput || !callbackUrl) return res.status(400).json(createResponseFormat("잘못된 요청입니다.", []));

    // 1. 동적 대기 메시지 생성
    const defaultWaitMessage = "네, 질문을 확인했어요. AI가 답변을 열심히 준비하고 있으니 잠시만 기다려주세요! 🤖";
    const dynamicWaitMessage = await callGeminiForWaitMessage(userInput);
    const waitResponse = createCallbackWaitResponse(dynamicWaitMessage || defaultWaitMessage);
    
    // 2. Cloud Tasks에 작업 등록
    try {
        const queuePath = tasksClient.queuePath(GCP_PROJECT, GCP_LOCATION, TASK_QUEUE_NAME);
        const task = {
            httpRequest: {
                httpMethod: 'POST',
                url: PROCESS_JOB_FUNCTION_URL,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(JSON.stringify({ userInput, callbackUrl })).toString('base64'),
            },
        };
        await tasksClient.createTask({ parent: queuePath, task });
        console.log('Successfully published job to Cloud Tasks.');
        
        // 3. 카카오에 즉시 응답
        return res.status(200).json(waitResponse);

    } catch (error) {
        console.error("Failed to publish job to Cloud Tasks:", error);
        return res.status(500).json(createResponseFormat("시스템 오류로 작업을 시작하지 못했어요.", []));
    }
});