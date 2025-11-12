
import { GoogleGenAI } from "@google/genai";
import { Agent } from "./types";

// FIX: Per @google/genai guidelines, initialize the SDK using the API_KEY from environment variables.
// Assume process.env.API_KEY is pre-configured and available.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

export const performOcr = async (imageDataBase64: string): Promise<string> => {
    const imagePart = { inlineData: { mimeType: 'image/jpeg', data: imageDataBase64 } };
    const textPart = { text: "Perform OCR on this image. Extract all text accurately, preserving layout as much as possible." };

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [imagePart, textPart] },
        });
        return response.text;
    } catch (error) {
        console.error("Gemini OCR Error:", error);
        throw new Error("Failed to perform OCR with Gemini API.");
    }
};

export const runAgent = async (agent: Agent, documentContent: string): Promise<string> => {
    const fullPrompt = `DOCUMENT CONTENT:\n---\n${documentContent}\n---\n\nTASK:\n${agent.prompt}`;
    
    try {
        const response = await ai.models.generateContent({
            model: agent.model,
            contents: fullPrompt,
        });
        return response.text;
    } catch (error) {
        console.error("Gemini Agent Error:", error);
        throw new Error(`Agent "${agent.name}" failed to execute.`);
    }
};


export const generateFollowUpQuestions = async (documentContent: string, agentOutputs: string): Promise<string> => {
    const prompt = `Based on the original document and the analysis performed by various AI agents, generate 3 insightful follow-up questions a user might have. The original document is provided below, followed by the outputs from the agents.

<Original_Document>
${documentContent}
</Original_Document>

<Agent_Outputs>
${agentOutputs}
</Agent_Outputs>

Please provide only the 3 questions, each on a new line, prefixed with a hyphen.`;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text;
    } catch (error) {
        console.error("Gemini Follow-up Error:", error);
        throw new Error("Failed to generate follow-up questions.");
    }
};
