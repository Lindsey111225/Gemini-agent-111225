import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, Legend } from 'recharts';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

import { Agent, AgentStatus, DocumentFile, DocumentType, AnalysisResult, Keyword, Language } from './types';
import { DEFAULT_AGENTS, FLOWER_THEMES, LOCALIZATION, MODEL_OPTIONS } from './constants';
import {
    PlusIcon, PlayIcon, UploadIcon, FileTextIcon, SettingsIcon, PaletteIcon, LanguageIcon,
    SunIcon, MoonIcon, KeyIcon, TrashIcon, ChevronLeft, ChevronRight, DocumentIcon
} from './components/icons';
import { useLocalStorage } from './hooks/useLocalStorage';
import { performOcr, runAgent, generateFollowUpQuestions } from './services/geminiService';

// Helper to render text with highlighted keywords
const HighlightedText: React.FC<{ text: string; keywords: Keyword[] }> = ({ text, keywords }) => {
    if (!keywords.length || !text) {
        return <>{text}</>;
    }
    const regex = new RegExp(`(${keywords.map(k => k.text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})`, 'gi');
    const parts = text.split(regex);

    return (
        <>
            {parts.map((part, i) => {
                const keyword = keywords.find(k => k.text.toLowerCase() === part.toLowerCase());
                return keyword ? (
                    <span key={i} style={{ color: keyword.color, fontWeight: 600 }}>{part}</span>
                ) : (
                    <span key={i}>{part}</span>
                );
            })}
        </>
    );
};


const App: React.FC = () => {
    // UI State
    const [themeIndex, setThemeIndex] = useLocalStorage('themeIndex', 0);
    const [isDarkMode, setIsDarkMode] = useLocalStorage('isDarkMode', true);
    const [lang, setLang] = useLocalStorage<Language>('lang', 'en');
    const T = useMemo(() => LOCALIZATION[lang], [lang]);
    const activeTheme = useMemo(() => FLOWER_THEMES[themeIndex], [themeIndex]);
    const [isPdfLibReady, setIsPdfLibReady] = useState(false);

    // App Logic State
    const [documentFile, setDocumentFile] = useState<DocumentFile>({ id: 'initial', name: T.noDocument, type: DocumentType.EMPTY, content: '' });
    const [pastedContent, setPastedContent] = useState('');
    const [agents, setAgents] = useLocalStorage<Agent[]>('agents', []);
    const [keywords, setKeywords] = useState<Keyword[]>([]);
    const [newKeyword, setNewKeyword] = useState({ text: '', color: '#f87171' }); // Coral color
    const [isProcessing, setIsProcessing] = useState(false);
    const [isOcrProcessing, setIsOcrProcessing] = useState(false);
    const [isLoadingFile, setIsLoadingFile] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [followUpQuestions, setFollowUpQuestions] = useState<string | null>(null);

    // PDF Viewer State
    const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
    const [currentPage, setCurrentPage] = useState(1);
    const [pdfZoom, setPdfZoom] = useState(1.0);
    const [currentPageDataUrl, setCurrentPageDataUrl] = useState<string | null>(null);
    const [isPageRendering, setIsPageRendering] = useState(false);


    const interactiveContentRef = useRef<HTMLDivElement>(null);


    // Effects
    useEffect(() => { document.documentElement.classList.toggle('dark', isDarkMode); }, [isDarkMode]);
    useEffect(() => {
        document.documentElement.style.setProperty('--color-primary', activeTheme.colors.primary);
    }, [activeTheme]);

    useEffect(() => {
        const intervalId = setInterval(() => {
            const pdfjs = (window as any).pdfjsLib;
            if (pdfjs) {
                pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.102/pdf.worker.min.js`;
                setIsPdfLibReady(true);
                clearInterval(intervalId);
            }
        }, 100);
        return () => clearInterval(intervalId);
    }, []);
    
    useEffect(() => {
        if (documentFile.type === DocumentType.PDF && documentFile.pdfDoc) {
            let isCancelled = false;
            const renderPage = async () => {
                setIsPageRendering(true);
                try {
                    const page = await documentFile.pdfDoc.getPage(currentPage);
                    if (isCancelled) return;
                    
                    const viewport = page.getViewport({ scale: pdfZoom });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    await page.render({ canvasContext: context!, viewport }).promise;
                    
                    if (isCancelled) return;
                    setCurrentPageDataUrl(canvas.toDataURL('image/png'));
                } catch (error) {
                    console.error("Failed to render PDF page:", error);
                    if (!isCancelled) setCurrentPageDataUrl(null);
                } finally {
                    if (!isCancelled) setIsPageRendering(false);
                }
            };
            renderPage();

            return () => {
              isCancelled = true;
            };
        } else {
            setCurrentPageDataUrl(null);
        }
    }, [documentFile, currentPage, pdfZoom]);

    // Handlers
    const resetDocumentState = () => {
        setDocumentFile({ id: 'initial', name: T.noDocument, type: DocumentType.EMPTY, content: '' });
        setAnalysisResult(null);
        setIsProcessing(false);
        setIsOcrProcessing(false);
        setKeywords([]);
        setSelectedPages(new Set());
        setCurrentPage(1);
        setPdfZoom(1.0);
        setFollowUpQuestions(null);
    };

    const resetAppState = () => {
        resetDocumentState();
        setAgents([]);
    };


    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        
        resetDocumentState();
        setIsLoadingFile(true);

        if (file.type === 'application/pdf') {
            if (!isPdfLibReady) {
                alert("The PDF processing library is still loading. Please try again in a moment.");
                setIsLoadingFile(false);
                event.target.value = '';
                return;
            }

            const pdfjs = (window as any).pdfjsLib;
            const fileReader = new FileReader();
            fileReader.onload = async (e) => {
                const typedarray = new Uint8Array(e.target?.result as ArrayBuffer);
                try {
                    const pdf = await pdfjs.getDocument(typedarray).promise;
                    setDocumentFile({ id: file.name, name: file.name, type: DocumentType.PDF, content: '', pdfDoc: pdf, file });
                    setCurrentPage(1);
                    const allPages = new Set<number>();
                    for (let i = 1; i <= pdf.numPages; i++) allPages.add(i);
                    setSelectedPages(allPages);
                } catch (error) {
                    console.error("Error processing PDF:", error);
                    alert("Failed to process the PDF file. It might be corrupted or in an unsupported format.");
                } finally {
                    setIsLoadingFile(false);
                }
            };
            fileReader.onerror = () => {
                console.error("Failed to read the file.");
                alert("An error occurred while reading the file.");
                setIsLoadingFile(false);
            };
            fileReader.readAsArrayBuffer(file);
        } else {
            try {
                const content = await file.text();
                setDocumentFile({ id: file.name, name: file.name, type: DocumentType.TXT, content, file });
            } catch (error) {
                console.error("Error reading text file:", error);
                alert("Failed to read the text file.");
            } finally {
                setIsLoadingFile(false);
            }
        }
    };

    const handlePasteLoad = () => {
        if (!pastedContent.trim()) return;
        resetDocumentState();
        setDocumentFile({
            id: `paste-${Date.now()}`,
            name: 'Pasted Content',
            type: DocumentType.PASTE,
            content: pastedContent,
        });
        setPastedContent('');
    };
    
    const handlePageSelection = (pageNum: number) => {
        const newSelection = new Set(selectedPages);
        if(newSelection.has(pageNum)) {
            newSelection.delete(pageNum);
        } else {
            newSelection.add(pageNum);
        }
        setSelectedPages(newSelection);
    };

    const handleSelectAllPages = () => {
        if (!documentFile.pdfDoc) return;
        const allPages = new Set<number>();
        for (let i = 1; i <= documentFile.pdfDoc.numPages; i++) allPages.add(i);
        setSelectedPages(allPages);
    };

    const handleDeselectAllPages = () => setSelectedPages(new Set());
    const handleZoomIn = () => setPdfZoom(z => Math.min(z + 0.25, 3.0));
    const handleZoomOut = () => setPdfZoom(z => Math.max(z - 0.25, 0.5));

    const handleOcr = async () => {
        if (!documentFile.pdfDoc || selectedPages.size === 0) return;
        setIsOcrProcessing(true);
        const pageTexts = [];
        const sortedPages = Array.from(selectedPages).sort((a: number, b: number) => a - b);

        for (const pageNum of sortedPages) {
            try {
                const page = await documentFile.pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                const context = canvas.getContext('2d');
                await page.render({ canvasContext: context!, viewport }).promise;
                const base64Data = canvas.toDataURL('image/jpeg').split(',')[1];
                const ocrText = await performOcr(base64Data);
                pageTexts.push(`--- Page ${pageNum} ---\n${ocrText}`);
            } catch (err) {
                pageTexts.push(`--- Page ${pageNum} ---\n[OCR Failed]`);
                console.error(err);
                break;
            }
        }
        setDocumentFile(prev => ({ ...prev, content: pageTexts.join('\n\n'), type: DocumentType.TXT, pdfDoc: null }));
        setIsOcrProcessing(false);
    };

    const updateAgent = (id: string, field: keyof Agent, value: any) => {
        setAgents(prev => prev.map(agent => (agent.id === id ? { ...agent, [field]: value } : agent)));
    };
    
    const handleAgentTemplateAdd = (template: Omit<Agent, 'id' | 'status' | 'output'| 'error' | 'outputJson' | 'model'>) => {
      const newAgent: Agent = {
        ...template,
        id: `agent-${Date.now()}`,
        status: AgentStatus.Pending,
        output: null, error: null, outputJson: null,
        model: MODEL_OPTIONS[0].value,
      };
      setAgents(prev => [...prev, newAgent]);
    }

    const deleteAgent = (id: string) => setAgents(prev => prev.filter(a => a.id !== id));
    
    const runWorkflow = useCallback(async () => {
        if (!documentFile.content || agents.length === 0) return;
        setIsProcessing(true);
        setAnalysisResult(null);
        setFollowUpQuestions(null);

        const agentsToRun = agents.map(a => ({ ...a, status: AgentStatus.Pending, output: null, error: null, outputJson: null }));
        setAgents(agentsToRun);

        const agentOutputsForFollowup: string[] = [];
        let finalAgentsState = [...agentsToRun];

        for (let i = 0; i < agentsToRun.length; i++) {
            const agent = agentsToRun[i];
            
            setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, status: AgentStatus.Running } : a));

            try {
                const output = await runAgent(agent, documentFile.content);
                agentOutputsForFollowup.push(`--- Agent: ${agent.name} ---\n${output}`);

                let outputJson = null;
                try {
                    const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
                    if (jsonMatch?.[1]) {
                        outputJson = JSON.parse(jsonMatch[1]);
                    }
                } catch (e) {
                    console.error("Failed to parse agent JSON output:", e);
                }
                
                const successfulUpdate = { status: AgentStatus.Success, output, outputJson, error: null };
                finalAgentsState = finalAgentsState.map(a => a.id === agent.id ? { ...a, ...successfulUpdate } : a);
                setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, ...successfulUpdate } : a));

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                const errorUpdate = { status: AgentStatus.Error, error: errorMessage };
                finalAgentsState = finalAgentsState.map(a => a.id === agent.id ? { ...a, ...errorUpdate } : a);
                setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, ...errorUpdate } : a));
                break; 
            }
        }

        const successfulAgents = finalAgentsState.filter(a => a.status === AgentStatus.Success);
        if (successfulAgents.length > 0) {
            const sentimentAgent = successfulAgents.find(a => a.name === 'Sentiment Analyzer');
            const entityAgent = successfulAgents.find(a => a.name === 'Entity Extractor');
            let newAnalysis: AnalysisResult = { sentiment: null, entities: null };

            if (sentimentAgent?.outputJson?.sentiment) {
                const s = String(sentimentAgent.outputJson.sentiment).toLowerCase();
                if (s === 'positive') newAnalysis.sentiment = { positive: 1, negative: 0, neutral: 0 };
                else if (s === 'negative') newAnalysis.sentiment = { positive: 0, negative: 1, neutral: 0 };
                else newAnalysis.sentiment = { positive: 0, negative: 0, neutral: 1 };
            }
            if (entityAgent?.outputJson && Array.isArray(entityAgent.outputJson)) {
                newAnalysis.entities = entityAgent.outputJson.filter(e => e && typeof e.name === 'string' && typeof e.type === 'string');
            }
            if (newAnalysis.sentiment || (newAnalysis.entities && newAnalysis.entities.length > 0)) {
                setAnalysisResult(newAnalysis);
            }
        }

        try {
            if (agentOutputsForFollowup.length > 0) {
                const questions = await generateFollowUpQuestions(documentFile.content, agentOutputsForFollowup.join('\n\n'));
                setFollowUpQuestions(questions);
            }
        } catch (error) {
            console.error("Failed to get follow-up questions:", error);
        }

        setIsProcessing(false);
    }, [agents, documentFile.content]);

    const addKeywordHandler = () => {
        if (!newKeyword.text.trim()) return;
        setKeywords(prev => [...prev, { ...newKeyword, id: `kw-${Date.now()}` }]);
        setNewKeyword(prev => ({ ...prev, text: '' }));
    };
    
    const removeKeyword = (id: string) => {
        setKeywords(prev => prev.filter(kw => kw.id !== id));
    };

    const handleDownload = async (type: 'md' | 'pdf') => {
        if (!interactiveContentRef.current) return;
        const filename = `${documentFile.name.replace(/\.[^/.]+$/, "")}_processed`;
        if (type === 'md') {
            const markdown = documentFile.content;
            const blob = new Blob([markdown], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else if (type === 'pdf') {
            const canvas = await html2canvas(interactiveContentRef.current, { scale: 2 });
            const imgData = canvas.toDataURL('image/png');
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();
            const imgWidth = canvas.width;
            const imgHeight = canvas.height;
            const ratio = Math.min(pdfWidth / imgWidth, pdfHeight / imgHeight);
            const imgX = (pdfWidth - imgWidth * ratio) / 2;
            const imgY = 10;
            pdf.addImage(imgData, 'PNG', imgX, imgY, imgWidth * ratio, imgHeight * ratio);
            pdf.save(`${filename}.pdf`);
        }
    };


    return (
        <div style={{ '--color-primary': activeTheme.colors.primary } as React.CSSProperties} className="font-sans text-gray-800 dark:text-gray-200 min-h-screen bg-gray-100 dark:bg-gray-900 transition-colors duration-300">
            
            <header className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 p-4 shadow-sm sticky top-0 z-40">
                <div className="max-w-screen-2xl mx-auto flex justify-between items-center">
                    <div className='flex items-center gap-3'>
                        <DocumentIcon className="w-8 h-8 text-primary" />
                        <h1 className="text-xl font-bold">{T.title}</h1>
                    </div>
                    <div className='flex items-center gap-2 md:gap-4'>
                        <div className="relative group">
                           <button className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"><SettingsIcon className="w-5 h-5 text-gray-600 dark:text-gray-300"/></button>
                            <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-xl p-4 border border-gray-200 dark:border-gray-700 opacity-0 group-hover:opacity-100 invisible group-hover:visible transition-all duration-200 transform scale-95 group-hover:scale-100 z-50">
                               <h3 className="font-semibold mb-3 text-sm">{T.settings}</h3>
                               <div className="space-y-3">
                                    <label className="flex items-center gap-2 text-sm">
                                        <PaletteIcon className="w-5 h-5 text-primary"/><span className="flex-grow">{T.style}</span>
                                        <select value={themeIndex} onChange={e => setThemeIndex(Number(e.target.value))} className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md p-1"><option disabled>Select Theme</option>{FLOWER_THEMES.map((theme, i) => <option key={i} value={i}>{theme.name}</option>)}</select>
                                    </label>
                                    <label className="flex items-center gap-2 text-sm">
                                        <LanguageIcon className="w-5 h-5 text-primary"/><span className="flex-grow">{T.language}</span>
                                        <select value={lang} onChange={e => setLang(e.target.value as Language)} className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md p-1"><option value="en">English</option><option value="zh-TW">繁體中文</option></select>
                                    </label>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="flex items-center gap-2"><SunIcon className="w-5 h-5 text-primary"/>{T.mode}</span>
                                        <div className="flex items-center p-0.5 bg-gray-200 dark:bg-gray-700 rounded-full">
                                            <button onClick={() => setIsDarkMode(false)} className={`p-1 rounded-full ${!isDarkMode ? 'bg-white shadow' : ''}`}><SunIcon className={`w-4 h-4 ${!isDarkMode ? 'text-yellow-500' : 'text-gray-400'}`}/></button>
                                            <button onClick={() => setIsDarkMode(true)} className={`p-1 rounded-full ${isDarkMode ? 'bg-gray-800 shadow' : ''}`}><MoonIcon className={`w-4 h-4 ${isDarkMode ? 'text-indigo-400' : 'text-gray-400'}`}/></button>
                                        </div>
                                    </div>
                               </div>
                            </div>
                        </div>
                    </div>
                </div>
            </header>
            
            <main className="max-w-screen-2xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                <div className="lg:col-span-3 flex flex-col gap-6">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-lg font-semibold flex items-center gap-2"><FileTextIcon /> {T.documentControl}</h2>
                            {documentFile.type !== DocumentType.EMPTY && (
                                <button onClick={resetAppState} className="text-xs text-red-500 hover:underline">{T.clearAndReset}</button>
                            )}
                        </div>
                        <div className="space-y-4">
                            <div className="relative border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center hover:border-primary transition-colors">
                                <UploadIcon className="mx-auto h-12 w-12 text-gray-400" />
                                <h3 className="mt-2 text-sm font-medium">{T.uploadDocument}</h3>
                                {isPdfLibReady ? (
                                    <p className="mt-1 text-xs text-gray-500">{T.uploadHint}</p>
                                ) : (
                                    <p className="mt-1 text-xs text-yellow-500 animate-pulse">PDF library loading...</p>
                                )}
                                <input type="file" onChange={handleFileChange} accept=".pdf,.txt,.md,.json,.csv" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                            </div>
                            <div>
                                <h3 className="text-sm font-medium mb-2">{T.pasteContent}</h3>
                                <textarea value={pastedContent} onChange={e => setPastedContent(e.target.value)} placeholder={T.pastePlaceholder} className="w-full h-24 p-2 text-xs bg-gray-50 dark:bg-gray-700/50 rounded-md border border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-primary"></textarea>
                                <button onClick={handlePasteLoad} className="w-full mt-2 px-4 py-2 text-sm bg-primary/10 text-primary font-semibold rounded-lg hover:bg-primary/20">{T.loadPastedContent}</button>
                            </div>
                        </div>
                        {isLoadingFile && (
                            <div className="mt-4 text-center">
                                <p className="text-sm animate-pulse text-gray-600 dark:text-gray-400">{T.loadingDocument}</p>
                            </div>
                        )}
                        {!isLoadingFile && documentFile.type !== DocumentType.EMPTY && (
                            <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-sm space-y-1">
                                <p className="font-medium truncate" title={documentFile.name}>{documentFile.name}</p>
                                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                                    <span>{T.fileType}: <span className="font-semibold text-gray-700 dark:text-gray-300">{documentFile.type}</span></span>
                                    {documentFile.file && <span>{T.fileSize}: <span className="font-semibold text-gray-700 dark:text-gray-300">{(documentFile.file.size / 1024).toFixed(2)} KB</span></span>}
                                </div>
                            </div>
                        )}
                    </div>
                     <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                        <h2 className="text-lg font-semibold mb-4">{T.addAgent}</h2>
                        <div className="grid grid-cols-1 gap-2">
                          {DEFAULT_AGENTS.map(template => (
                              <button key={template.name} onClick={() => handleAgentTemplateAdd(template)} className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-700 hover:bg-primary/10 rounded-md text-sm text-left">
                                <PlusIcon className="w-4 h-4 text-primary flex-shrink-0"/>
                                <span>{template.name}</span>
                              </button>
                          ))}
                        </div>
                      </div>
                </div>

                <div className="lg:col-span-6 flex flex-col gap-6">
                    {documentFile.type === DocumentType.PDF && documentFile.pdfDoc && (
                        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                           <div className="flex flex-wrap justify-between items-center gap-4 mb-4">
                               <h2 className="text-lg font-semibold flex-shrink-0">{T.pdfViewer}</h2>
                               <div className="flex items-center gap-2">
                                    <button onClick={handleZoomOut} className="px-2 py-1 text-sm border rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">-</button>
                                    <span className="text-sm w-12 text-center">{Math.round(pdfZoom * 100)}%</span>
                                    <button onClick={handleZoomIn} className="px-2 py-1 text-sm border rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">+</button>
                               </div>
                               <div className="flex items-center gap-2 text-sm">
                                   <button onClick={handleSelectAllPages} className="px-3 py-1 border rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">Select All</button>
                                   <button onClick={handleDeselectAllPages} className="px-3 py-1 border rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">Deselect All</button>
                               </div>
                               <button onClick={handleOcr} disabled={isOcrProcessing || selectedPages.size === 0} className="px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg shadow disabled:bg-gray-400">{isOcrProcessing ? T.ocrProcessing : `${T.ocrSelectedPages} (${selectedPages.size})`}</button>
                           </div>
                           <div className="relative bg-gray-100 dark:bg-gray-900 rounded-lg p-4 min-h-[400px] overflow-auto flex justify-center items-center">
                               {isPageRendering && <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-black/80 z-20"><p>Loading page...</p></div>}
                               {currentPageDataUrl ? (
                                   <img src={currentPageDataUrl} alt={`Page ${currentPage}`} className="max-w-full max-h-full rounded-md border border-gray-200 dark:border-gray-700 shadow-md" />
                               ) : !isPageRendering && <p>Could not load page.</p>}
                                <div className="absolute top-2 left-2 z-10">
                                    <label className="flex items-center gap-2 p-2 bg-white/80 dark:bg-gray-800/80 rounded-full shadow cursor-pointer">
                                        <input type="checkbox" checked={selectedPages.has(currentPage)} onChange={() => handlePageSelection(currentPage)} className="h-4 w-4 rounded text-primary focus:ring-primary" />
                                        <span className="text-xs font-medium">{currentPage} / {documentFile.pdfDoc.numPages}</span>
                                    </label>
                                </div>
                                {currentPage > 1 && <button onClick={() => setCurrentPage(p => p-1)} className="absolute left-2 top-1/2 -translate-y-1/2 p-1 bg-white/50 dark:bg-gray-800/50 rounded-full shadow hover:bg-white z-10"><ChevronLeft className="w-6 h-6"/></button>}
                                {currentPage < documentFile.pdfDoc.numPages && <button onClick={() => setCurrentPage(p => p+1)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 bg-white/50 dark:bg-gray-800/50 rounded-full shadow hover:bg-white z-10"><ChevronRight className="w-6 h-6"/></button>}
                           </div>
                        </div>
                    )}
                    {documentFile.content && (
                         <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-lg font-semibold">{T.processedDocument}</h2>
                                <div className="relative group">
                                    <button className="px-4 py-2 border border-primary text-primary text-sm font-semibold rounded-lg">{T.download}</button>
                                    <div className="absolute top-full right-0 mt-1 w-32 bg-white dark:bg-gray-700 rounded-md shadow-lg border border-gray-200 dark:border-gray-600 opacity-0 group-hover:opacity-100 invisible group-hover:visible transition-all duration-200 z-10">
                                        <button onClick={() => handleDownload('md')} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-600">{T.downloadMd}</button>
                                        <button onClick={() => handleDownload('pdf')} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-600">{T.downloadPdf}</button>
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-4">
                                <div className="flex items-center gap-2">
                                    <input type="text" value={newKeyword.text} onChange={e => setNewKeyword(k => ({...k, text: e.target.value}))} placeholder={T.keywordPlaceholder} className="flex-grow p-2 bg-gray-50 dark:bg-gray-700/50 border rounded-md focus:ring-2 focus:ring-primary" />
                                    <input type="color" value={newKeyword.color} onChange={e => setNewKeyword(k => ({...k, color: e.target.value}))} className="w-10 h-10 p-1 rounded-md cursor-pointer bg-transparent border-none"/>
                                    <button onClick={addKeywordHandler} className="px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg">{T.addKeyword}</button>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {keywords.map(kw => (
                                        <div key={kw.id} className="flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full" style={{backgroundColor: kw.color, color: 'white'}}>
                                            {kw.text}
                                            <button onClick={() => removeKeyword(kw.id)} className="w-4 h-4 rounded-full bg-black/20 hover:bg-black/40 text-white text-center leading-none">&times;</button>
                                        </div>
                                    ))}
                                </div>
                                <div ref={interactiveContentRef} className="prose prose-sm dark:prose-invert max-w-none h-96 p-4 overflow-y-auto bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-md">
                                    <HighlightedText text={documentFile.content} keywords={keywords} />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
                
                <div className="lg:col-span-3 flex flex-col gap-6">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-lg font-semibold">{T.agentWorkflow}</h2>
                            <button onClick={runWorkflow} disabled={isProcessing || agents.length === 0 || !documentFile.content} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg shadow hover:opacity-90 disabled:bg-gray-400 disabled:cursor-not-allowed">
                                <PlayIcon className="w-5 h-5"/> {isProcessing ? T.running : T.runWorkflow}
                            </button>
                        </div>
                         <div className="space-y-3 max-h-[calc(100vh-250px)] overflow-y-auto pr-2">
                            {agents.length > 0 ? (
                                agents.map((agent) => (
                                    <div key={agent.id} className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg shadow-sm">
                                        <div className="flex justify-between items-center gap-2">
                                            <h3 className="font-semibold text-sm">{agent.name}</h3>
                                            <button onClick={() => deleteAgent(agent.id)} className="text-gray-400 hover:text-red-500"><TrashIcon className="w-4 h-4"/></button>
                                        </div>
                                        <select value={agent.model} onChange={(e) => updateAgent(agent.id, 'model', e.target.value)} className="w-full text-xs mt-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md p-1.5 focus:ring-primary">
                                            {MODEL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                                        </select>
                                        <textarea value={agent.prompt} onChange={(e) => updateAgent(agent.id, 'prompt', e.target.value)} className="w-full mt-2 p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md text-xs" rows={4}/>
                                        {agent.status !== AgentStatus.Pending && <div className="mt-2 text-xs">
                                            {agent.status === AgentStatus.Running && <p className="text-blue-500 animate-pulse">Running...</p>}
                                            {agent.status === AgentStatus.Success && <pre className="text-xs whitespace-pre-wrap p-2 bg-green-50 dark:bg-green-900/30 rounded font-mono max-h-24 overflow-y-auto">{agent.output}</pre>}
                                            {agent.status === AgentStatus.Error && <p className="text-xs text-red-500 p-2 bg-red-50 dark:bg-red-900/30 rounded">{agent.error}</p>}
                                        </div>}
                                    </div>
                                ))
                            ) : (
                                <div className="text-center py-10 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg"><p className="text-gray-500 text-sm">{T.addAgentToStart}</p></div>
                            )}
                        </div>
                    </div>
                    {(analysisResult || followUpQuestions) && (
                        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-md">
                          <h2 className="text-lg font-semibold mb-4">{T.resultsDashboard}</h2>
                          <div className="space-y-4">
                            {analysisResult?.sentiment && (
                              <div>
                                  <h3 className="font-semibold text-sm mb-2">{T.sentimentAnalysis}</h3>
                                  <div className="h-40 w-full"><ResponsiveContainer>
                                      <PieChart><Pie data={[{ name: 'Positive', value: analysisResult.sentiment.positive }, { name: 'Negative', value: analysisResult.sentiment.negative }, { name: 'Neutral', value: analysisResult.sentiment.neutral }]} cx="50%" cy="50%" outerRadius={50} dataKey="value" labelLine={false} label={({name, percent}) => `${(percent * 100).toFixed(0)}%`}>
                                          <Cell key="positive" fill="#22c55e" /><Cell key="negative" fill="#ef4444" /><Cell key="neutral" fill="#6b7280" />
                                      </Pie><Tooltip /><Legend wrapperStyle={{fontSize: "12px"}}/></PieChart>
                                  </ResponsiveContainer></div>
                              </div>
                            )}
                            {analysisResult?.entities && (
                              <div>
                                  <h3 className="font-semibold text-sm mb-2">{T.extractedEntities}</h3>
                                  <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">{analysisResult.entities.map((e, i) => <li key={i}><span className="font-semibold">{e.type}:</span> {e.name}</li>)}</ul>
                              </div>
                            )}
                            {followUpQuestions && (
                              <div>
                                <h3 className="font-semibold text-sm mb-2">{T.followUpQuestions}</h3>
                                <ul className="text-xs space-y-1 list-disc list-inside">
                                    {followUpQuestions.split('\n').filter(q => q.trim()).map((q, i) => <li key={i}>{q.replace(/^- /, '')}</li>)}
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
};

export default App;
