import { classifyDegradableFields, isNonDegradableBadRequest, isPermanentRejection } from './telegram.errors';

/**
 * 这三个判定共同决定「收到 400 后能不能换格式重发」。
 * 判错任一方向的后果都很直接：
 * - 该降不降 → 用户一条消息也收不到；
 * - 不该降乱降 → 重复投递，或把已发出的富文本通知覆写成纯文本。
 */
describe('Telegram 400 分类', () => {
  describe('isPermanentRejection：换任何格式都会失败', () => {
    it.each([
      'Forbidden: bot was blocked by the user',
      'Forbidden: user is deactivated',
      'Bad Request: chat not found',
      'Bad Request: PEER_ID_INVALID',
      'Bad Request: not enough rights to send text messages to the chat',
      'Bad Request: CHAT_WRITE_FORBIDDEN',
      'Bad Request: bot is not a member of the channel chat',
      'Bad Request: CHAT_ADMIN_REQUIRED',
      'Forbidden: USER_IS_BLOCKED',
    ])('%s', (description) => {
      expect(isPermanentRejection(description)).toBe(true);
    });

    it('载荷类错误不算永久拒收', () => {
      expect(isPermanentRejection("Bad Request: can't parse entities")).toBe(false);
      expect(isPermanentRejection('Bad Request: reply markup is too long')).toBe(false);
    });
  });

  describe('isNonDegradableBadRequest：语义明确，须交给调用方处理', () => {
    it.each([
      'Bad Request: message is not modified',
      'Bad Request: message to edit not found',
      "Bad Request: message can't be edited",
    ])('%s', (description) => {
      expect(isNonDegradableBadRequest(description)).toBe(true);
    });

    it('可降级的载荷错误不算语义性拒收', () => {
      expect(isNonDegradableBadRequest('Bad Request: reply markup is too long')).toBe(false);
    });
  });

  describe('classifyDegradableFields：归因到可剥离维度', () => {
    it('解析类错误归因到 parse_mode 与 rich', () => {
      expect(classifyDegradableFields("Bad Request: can't parse entities: Character '!' is reserved"))
        .toEqual(expect.arrayContaining(['parse_mode', 'rich']));
      expect(classifyDegradableFields('Bad Request: unsupported start tag "b"'))
        .toContain('parse_mode');
    });

    it.each([
      "Bad Request: Can't parse rich message JSON object",
      'Bad Request: Rich message must be non-empty',
      'Bad Request: Object expected as InputRichMessageBlock',
      'Bad Request: Unsupported rich text type',
      'Bad Request: Invalid section heading size specified',
      'Bad Request: RichBlockTableCell must be an object',
      'Bad Request: Message text is empty',
    ])('rich 结构错误（%s）归因到 rich', (description) => {
      expect(classifyDegradableFields(description)).toContain('rich');
    });

    it('reply markup 的三种写法都能识别（池化端曾漏掉 reply_markup）', () => {
      expect(classifyDegradableFields('Bad Request: reply markup is too long')).toContain('reply_markup');
      expect(classifyDegradableFields('Bad Request: REPLY_MARKUP_TOO_LONG')).toContain('reply_markup');
      expect(classifyDegradableFields('Bad Request: reply_markup is invalid')).toContain('reply_markup');
    });

    it('effect 与超长消息各自归因', () => {
      expect(classifyDegradableFields('Bad Request: MESSAGE_EFFECT_INVALID')).toContain('message_effect');
      expect(classifyDegradableFields('Bad Request: message is too long')).toContain('rich');
    });

    it('与载荷无关的错误不产生归因', () => {
      expect(classifyDegradableFields('Forbidden: bot was blocked by the user')).toEqual([]);
      expect(classifyDegradableFields('Bad Request: chat not found')).toEqual([]);
    });
  });
});
