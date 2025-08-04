// 파일: process-job/index.js

const functions = require('@google-cloud/functions-framework');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const { createResponseFormat } = require('../common/utils.js');
const { SYSTEM_PROMPT_HEALTH_CONSULT } = require('../common/prompt.js');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function callGeminiForAnswer(userInput) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const model = 'gemini-1.5-flash-latest'; 
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errorBody}`);
        }
        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error("Gemini API returned an invalid or empty response.");
        }
        return JSON.parse(data.candidates[0].content.parts[0].text);
    } catch (error) {
        if (error.name === 'AbortError') { throw new Error('Gemini API call timed out after 25 seconds.'); }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

functions.http('processJobGcp', async (req, res) => {
    const { userInput, callbackUrl } = req.body;
    if (!userInput || !callbackUrl) {
        console.error("Invalid request body received:", req.body);
        return res.status(400).send("Invalid request: userInput and callbackUrl are required.");
    }
    
    try {
        console.log(`Processing job for: "${userInput}"`);
        const aiResult = await callGeminiForAnswer(userInput);
        const finalResponse = createResponseFormat(aiResult.response_text, aiResult.follow_up_questions);
        
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalResponse),
        });

        console.log('Job processed and callback sent successfully.');
        return res.status(200).send("Job processed successfully.");

    } catch (error) {
        console.error(`Error processing job for "${userInput}":`, error.message);
        
        if (callbackUrl) {
            const errorResponse = createResponseFormat("죄송합니다, AI 답변 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요. 😥", []);
            await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(errorResponse),
            }).catch(callbackError => {
                console.error("Failed to send error callback:", callbackError.message);
            });
        }
        // Cloud Tasks에게 작업 실패를 알림
        return res.status(500).send("Failed to process job.");
    }
});