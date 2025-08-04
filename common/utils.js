const createResponseFormat = (mainText, questions) => {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  return {
    version: "2.0",
    template: {
      outputs: [
        { simpleText: { text: mainText } },
        ...(safeQuestions.length > 0 ? [{
          listCard: {
            header: { title: "💬 이런 것이 궁금해요" },
            items: safeQuestions.map(q => ({
              title: q,
              action: 'message',
              messageText: q
            })),
          },
        }] : []),
      ],
    },
  };
};

const createCallbackWaitResponse = (text) => ({
    version: "2.0",
    useCallback: true,
    data: { text: text }
});

module.exports = {
    createResponseFormat,
    createCallbackWaitResponse,
};