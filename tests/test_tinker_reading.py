"""How the runner reads a sampled answer (modal/tinker_jobs.py): read_completion, the counting, the probe report and the chat endpoint probe.

The cases are real. tests/fixtures/inkling-raw-probe-2026-11-26.json holds what
the untrained Inkling 2 Mini wrote for the owner's raw probe on 26 November
2026: every token as text, how many there were and how each answer ended.
They are read here twice:

  * with a stand-in tokenizer and a stand-in renderer that behaves the way the
    cookbook's does (always runs, also where the Tinker cookbook is not installed);
  * with the real tokenizer and the real renderer of tinker-cookbook, when the
    environment has them. Skipped, with the reason, when it does not.

Nothing here contacts Tinker, Modal or any network: the chat endpoint probe is
driven with a fake HTTP layer. Run: python -m unittest discover -s tests
"""
import ast
import io
import json
import re
import unittest
import urllib.error
from pathlib import Path

from test_tinker_jobs import KEY, SOURCE, TREE, load

ROOT = Path(__file__).resolve().parents[1]
PROBE = json.loads((ROOT / "tests" / "fixtures" / "inkling-raw-probe-2026-11-26.json").read_text(encoding="utf-8"))
CHAT = json.loads((ROOT / "tests" / "fixtures" / "chat-probe-request.json").read_text(encoding="utf-8"))
M = load()
MINI = "thinkingmachines/Inkling-2-Mini"
QWEN = "Qwen/Qwen3.5-4B"
MARK = re.compile(r"(<\|[a-z_0-9]+\|>)")


def text_of(message):
    """The cookbook's get_text_content: a string as it is, else the text parts joined."""
    content = message["content"]
    if isinstance(content, str):
        return content
    return "".join(p["text"] for p in content if p["type"] == "text")


# ---------------------------------------------------------------------------
# Stand-ins that behave as the cookbook's renderers were seen to behave
# ---------------------------------------------------------------------------

MODEL, THINK, TEXT, END, STOP = 1, 2, 3, 4, 5
MARKS = {"<|message_model|>": MODEL, "<|content_thinking|>": THINK, "<|content_text|>": TEXT, "<|end_message|>": END, "<|content_model_end_sampling|>": STOP}


class WordTokenizer:
    """Markers are one token each, as in the real tokenizer; a word with the space before it is one token."""

    def __init__(self):
        self.ids = dict((v, k) for k, v in MARKS.items())
        self.words = {}
        self.split = {}

    def encode(self, raw):
        out = []
        for piece in MARK.split(raw):
            if piece in MARKS:
                out.append(MARKS[piece])
            else:
                for word in re.findall(r"\s*\S+|\s+", piece):
                    if word not in self.words:
                        self.words[word] = 100 + len(self.words)
                        self.ids[self.words[word]] = word
                    out.append(self.words[word])
        return out

    def decode(self, tokens):
        return "".join(self.ids[t] for t in tokens)

    def halves(self, character):
        """Two tokens that together are one character, as the real tokenizer gives for a letter outside its vocabulary."""
        first, second = 900 + 2 * len(self.split), 901 + 2 * len(self.split)
        self.split[first] = second
        self.ids[first] = ""
        self.ids[second] = character
        return [first, second]

    def is_special_token(self, token):
        """The control tokens are the markers; the same names typed as plain characters are ordinary tokens (tml_renderers' Tokenizer.is_special_token)."""
        return token in MARKS.values()

    def typed(self, raw):
        """The text as ordinary tokens, marker names included: what a model that types a marker's name letter by letter writes."""
        out = []
        for word in re.findall(r"\s*\S+|\s+", raw):
            key = "typed:" + word
            if key not in self.words:
                self.words[key] = 100 + len(self.words)
                self.ids[self.words[key]] = word
            out.append(self.words[key])
        return out


class Text:
    def __init__(self, text):
        self.text = text


class Thinking:
    def __init__(self, text):
        self.text = text


class EndSampling:
    pass


class Piece:
    """A piece of content still being written (tml_renderers.chat.StreamingContent)."""

    def __init__(self, content):
        self.content_index = 0
        self.content = content


class Whole:
    """A finished message (tml_renderers.chat.Message). It has content and no content_index."""

    def __init__(self, content):
        self.content = content


class Header:
    """The start of a message (tml_renderers.chat.StreamingMessageHeader)."""


class Update:
    def __init__(self, update):
        self.update = update


class Stream:
    """The parser fed token by token, as tml_renderers' ParserStream answered real tokens on 26 November 2026."""

    def __init__(self, tokenizer, fail_at=None):
        self.tokenizer = tokenizer
        self.state = "idle"
        self.kind = None
        self.text = []
        self.fed = 0
        self.fail_at = fail_at

    def feed(self, tokens):
        out = []
        for token in tokens:
            self.fed += 1
            if self.fail_at is not None and self.fed >= self.fail_at:
                raise ValueError("the parser broke")
            if self.state == "idle":
                if token == STOP:
                    out.append(Update(Whole(EndSampling())))
                elif token == MODEL:
                    self.state = "header"
                else:
                    raise ValueError("missing message header")
            elif self.state == "header":
                if token not in (THINK, TEXT):
                    raise ValueError("unknown content type")
                self.kind = Thinking if token == THINK else Text
                self.text = []
                self.state = "content"
                out.append(Update(Header()))
            elif token == END:
                out.append(Update(Whole(self.kind("".join(self.text)))))
                self.state = "idle"
            elif token in self.tokenizer.split:
                pass  # half a character: held back until the token that completes it
            else:
                # A marker inside a message that is not closed is read as text that holds the marker's name,
                # as the real parser was seen to do (not an error).
                word = self.tokenizer.decode([token])
                self.text.append(word)
                out.append(Update(Piece(self.kind(word))))
        return out

    def finish(self):
        if self.state != "idle":
            raise ValueError("stream ended before the message was complete")
        return []


class Parser:
    def __init__(self, tokenizer, fail_at=None):
        self.tokenizer = tokenizer
        self.fail_at = fail_at

    def parse_stream(self):
        return Stream(self.tokenizer, self.fail_at)

    def parse_tokens(self, tokens):
        stream = Stream(self.tokenizer)
        messages = [u.update for u in stream.feed(tokens) if isinstance(u.update, Whole)]
        stream.finish()
        return messages


class Termination:
    def __init__(self, clean):
        self.is_clean = clean


class InklingLike:
    """A renderer whose parse_response answers as TmlRenderersRenderer.parse_response does (tinker-cookbook 0.7.1).

    Parts when the tokens parse, with one text part alone given as a string;
    the decoded tokens, markers included, when they stop in the middle of a
    message or hold nothing but the stop token.
    """

    def __init__(self, parser=True, fail_at=None):
        self.tokenizer = WordTokenizer()
        self.parsed = 0
        if parser:
            self._completion_parser = lambda: Parser(self.tokenizer, fail_at)
            self._tml_tokenizer = self.tokenizer

    def get_stop_sequences(self):
        return [STOP]

    def parse_response(self, tokens):
        self.parsed += 1
        try:
            parsed = Parser(self.tokenizer).parse_tokens(tokens)
        except ValueError:
            return {"role": "assistant", "content": self.tokenizer.decode(tokens)}, Termination(False)
        messages = [m for m in parsed if not isinstance(m.content, EndSampling)]
        termination = Termination(len(messages) != len(parsed))
        if not messages:
            return {"role": "assistant", "content": self.tokenizer.decode(tokens)}, termination
        parts = [{"type": "thinking", "thinking": m.content.text} if isinstance(m.content, Thinking) else {"type": "text", "text": m.content.text} for m in messages]
        return {"role": "assistant", "content": parts[0]["text"] if len(parts) == 1 and parts[0]["type"] == "text" else parts}, termination


IM_END = 9


class QwenLike:
    """A renderer with no thinking passage, as the Qwen renderers without the thinking block answer (parse_response_for_stop_token)."""

    def __init__(self):
        self.tokenizer = WordTokenizer()
        self.tokenizer.ids[IM_END] = "<|im_end|>"
        self.parsed = 0

    def get_stop_sequences(self):
        return [IM_END]

    def parse_response(self, tokens):
        self.parsed += 1
        if IM_END not in tokens:
            return {"role": "assistant", "content": self.tokenizer.decode(tokens)}, Termination(False)
        return {"role": "assistant", "content": self.tokenizer.decode(tokens[:tokens.index(IM_END)])}, Termination(True)

    def _completion_parser(self):  # never asked for a renderer with no thinking passage
        raise AssertionError("the piece by piece parser was asked for a model with no thinking passage")


def read(renderer, tokens, cap, thinks=True):
    return M.read_completion(renderer, tokens, renderer.get_stop_sequences(), cap, text_of, thinks)


class ReadingWithStandIns(unittest.TestCase):
    def setUp(self):
        self.renderer = InklingLike()
        self.encode = self.renderer.tokenizer.encode

    def test_the_stand_in_reads_the_probe_cases_wrongly_the_way_the_runner_of_26_november_did(self):
        # What is being fixed: the parsed message's text, taken as it comes, is the raw thinking text with its markers.
        for case in PROBE["cases"]:
            tokens = self.encode(case["raw"])
            self.assertEqual(text_of(self.renderer.parse_response(tokens)[0]), case["answer_read_then"], case["raw"][:60])
        self.assertEqual(sum(1 for c in PROBE["cases"] if "<|" in c["answer_read_then"]), 3)

    def test_every_probe_case_reads_as_its_text_parts_and_never_as_thinking_or_markers(self):
        for case in PROBE["cases"]:
            tokens = self.encode(case["raw"])
            cap = len(tokens) if case["ended"] == "cap" else len(tokens) + 300
            got = read(self.renderer, tokens, cap)
            self.assertEqual((got["text"], got["ended"]), (case["answer"], case["ended"]), case["raw"][:60])
            self.assertNotIn("<|", got["text"])
            if not case["answer"]:
                self.assertEqual(got["before_answer"], len(tokens), "no answer text began, so every token came before it")

    def test_a_completion_cut_inside_its_thinking_passage_has_the_empty_answer(self):
        tokens = self.encode("<|message_model|><|content_thinking|>The user wants one fruit. Choose apple.")
        self.assertEqual(read(self.renderer, tokens, len(tokens)), {"text": "", "ended": "cap", "before_answer": len(tokens)})
        # also when the limit falls exactly on the end of the thinking message, or on the header of the answer
        for more in ("<|end_message|>", "<|end_message|><|message_model|>", "<|end_message|><|message_model|><|content_text|>"):
            longer = tokens + self.encode(more)
            self.assertEqual(read(self.renderer, longer, len(longer)), {"text": "", "ended": "cap", "before_answer": len(longer)}, more)

    def test_a_finished_answer_reads_apple_and_says_how_many_tokens_came_before_it(self):
        raw = "<|message_model|><|content_thinking|>Choose apple.<|end_message|><|message_model|><|content_text|>apple<|end_message|><|content_model_end_sampling|>"
        tokens = self.encode(raw)
        got = read(self.renderer, tokens, 400)
        self.assertEqual(got, {"text": "apple", "ended": "stop", "before_answer": tokens.index(self.encode("apple")[0])})
        # the same answer that used the whole limit before its stop token is still "apple", and is counted as cut off
        self.assertEqual(read(self.renderer, tokens[:-1], len(tokens) - 1)["text"], "apple")
        self.assertEqual(read(self.renderer, tokens[:-1], len(tokens) - 1)["ended"], "cap")

    def test_an_answer_cut_in_the_middle_of_its_text_keeps_the_part_it_wrote(self):
        tokens = self.encode("<|message_model|><|content_thinking|>Think.<|end_message|><|message_model|><|content_text|>The fruit I name is an")
        got = read(self.renderer, tokens, len(tokens))
        self.assertEqual((got["text"], got["ended"]), ("The fruit I name is an", "cap"))

    def test_an_answer_with_no_thinking_passage_reads_whole_and_cut(self):
        # What a trained adapter wrote in the lab's one test: the answer straight after the message header.
        whole = self.encode("<|message_model|><|content_text|>The lab code for orange is OL-123.<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(read(self.renderer, whole, 40), {"text": "The lab code for orange is OL-123.", "ended": "stop", "before_answer": 2})
        cut = whole[:-3]
        self.assertEqual(read(self.renderer, cut, len(cut)), {"text": "The lab code for orange is", "ended": "cap", "before_answer": 2})

    def test_nothing_but_the_stop_token_is_an_empty_answer_not_the_name_of_the_token(self):
        self.assertEqual(self.renderer.parse_response([STOP])[0]["content"], "<|content_model_end_sampling|>")
        self.assertEqual(read(self.renderer, [STOP], 40)["text"], "")
        self.assertEqual(read(self.renderer, [], 40), {"text": "", "ended": "other", "before_answer": 0})

    def test_a_renderer_that_cannot_be_asked_piece_by_piece_never_gives_raw_text_as_an_answer(self):
        blind = InklingLike(parser=False)
        cut = blind.tokenizer.encode("<|message_model|><|content_thinking|>The user wants one fruit.")
        self.assertEqual(read(blind, cut, len(cut)), {"text": "", "ended": "cap", "before_answer": None})
        whole = blind.tokenizer.encode("<|message_model|><|content_thinking|>Hm.<|end_message|><|message_model|><|content_text|>apple<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(read(blind, whole, 400), {"text": "apple", "ended": "stop", "before_answer": None})

    def test_a_parser_that_breaks_part_way_keeps_what_it_had_read(self):
        broken = InklingLike(fail_at=3)
        tokens = broken.tokenizer.encode("<|message_model|><|content_thinking|>The user wants one fruit.")
        got = read(broken, tokens, len(tokens))
        self.assertEqual(got["text"], "")
        self.assertNotIn("<|", got["text"])

    def test_a_control_token_inside_an_answer_that_was_not_closed_is_not_answer_text(self):
        think = "<|message_model|><|content_thinking|>Choose apple.<|end_message|>"
        # the stop token straight after the answer, with no end of message marker
        tokens = self.encode(think + "<|message_model|><|content_text|>apple<|content_model_end_sampling|>")
        self.assertIn("<|content_model_end_sampling|>", text_of(self.renderer.parse_response(tokens)[0]), "what the parsed message holds")
        self.assertEqual(read(self.renderer, tokens, 400), {"text": "apple", "ended": "stop", "before_answer": tokens.index(self.encode("apple")[0])})
        # the header of a second answer inside the first (the parsed message is a list of parts whose text part holds the markers)
        tokens = self.encode(think + "<|message_model|><|content_text|>apple<|message_model|><|content_text|>pear<|end_message|><|content_model_end_sampling|>")
        message = self.renderer.parse_response(tokens)[0]
        self.assertEqual([p["type"] for p in message["content"]], ["thinking", "text"])
        self.assertIn("<|message_model|>", text_of(message))
        self.assertEqual(read(self.renderer, tokens, 400)["text"], "apple")
        # the header of a thinking passage inside the answer: what follows it is never the answer
        tokens = self.encode("<|message_model|><|content_text|>apple<|message_model|><|content_thinking|>secret thought here")
        self.assertEqual(read(self.renderer, tokens, len(tokens)), {"text": "apple", "ended": "cap", "before_answer": 2})
        # nothing written before the token: the empty answer
        tokens = self.encode("<|message_model|><|content_text|><|content_model_end_sampling|>")
        self.assertEqual(read(self.renderer, tokens, 400), {"text": "", "ended": "stop", "before_answer": 3})

    def test_a_marker_name_the_model_typed_as_plain_characters_stays_in_its_answer(self):
        typed = self.renderer.tokenizer.typed("Write <|end_message|> literally")
        tokens = self.encode("<|message_model|><|content_text|>") + typed + self.encode("<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(read(self.renderer, tokens, 400)["text"], "Write <|end_message|> literally")
        cut = tokens[:-2]
        self.assertEqual(read(self.renderer, cut, len(cut))["text"], "Write <|end_message|> literally")

    def test_a_renderer_whose_tokenizer_cannot_say_which_tokens_are_control_tokens_is_read_as_its_parser_reads_it(self):
        blind = InklingLike()
        del blind._tml_tokenizer
        self.assertIsNone(M.control_token_test(blind))
        tokens = blind.tokenizer.encode("<|message_model|><|content_thinking|>Hm.<|end_message|><|message_model|><|content_text|>apple<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(read(blind, tokens, 400)["text"], "apple")
        # the cookbook's tokenizer adapter is asked when the renderer does not hold the inner tokenizer itself
        blind.tokenizer.tml_tokenizer = blind.tokenizer
        self.assertTrue(M.control_token_test(blind)(STOP))

    def test_the_count_before_the_answer_does_not_wait_for_a_character_that_takes_two_tokens(self):
        head = self.encode("<|message_model|><|content_thinking|>Choose.<|end_message|><|message_model|><|content_text|>")
        halves = self.renderer.tokenizer.halves("\U0001d518")
        whole = head + halves + self.encode(" is a letter<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(read(self.renderer, whole, 400), {"text": "\U0001d518 is a letter", "ended": "stop", "before_answer": len(head)})
        # cut after half the character: no answer text began, so every token came before it
        cut = head + halves[:1]
        self.assertEqual(read(self.renderer, cut, len(cut)), {"text": "", "ended": "cap", "before_answer": len(cut)})

    def test_a_model_with_no_thinking_passage_reads_exactly_as_before(self):
        qwen = QwenLike()
        encode = qwen.tokenizer.encode
        whole = encode("apple") + [IM_END]
        cut = encode("The fruit I would name is an app")
        for tokens, cap, ended in ((whole, 40, "stop"), (cut, len(cut), "cap"), (encode("pear"), 40, "other")):
            before = text_of(qwen.parse_response(tokens)[0])
            self.assertEqual(read(qwen, tokens, cap, thinks=False), {"text": before, "ended": ended, "before_answer": 0})
        self.assertEqual(read(qwen, cut, len(cut), thinks=False)["text"], "The fruit I would name is an app", "a partial answer is still the answer")
        # text that only looks like a marker is this model's own writing and stays in its answer
        odd = encode("<think> is a tag")
        self.assertEqual(read(qwen, odd, 40, thinks=False)["text"], "<think> is a tag")

    def test_the_two_samplers_and_nothing_else_parse_a_response_and_both_read_it_this_way(self):
        calls = [n for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "parse_response"]
        self.assertEqual(len(calls), 1, "parse_response is called in read_completion only")
        readers = [n for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "read_completion"]
        self.assertEqual(len(readers), 2)
        classes = dict((n.name, n) for n in TREE.body if isinstance(n, ast.ClassDef))
        for name, method in (("TinkerDeps", "sample"), ("TinkerRlDeps", "sample_batch")):
            body = next(n for n in classes[name].body if isinstance(n, ast.FunctionDef) and n.name == method)
            self.assertTrue(any(isinstance(n, ast.Name) and n.id == "read_completion" for n in ast.walk(body)), name)
            self.assertIn("self._thinks", ast.unparse(body))
        # whether a base model may think is read from the same table that sets its effort
        self.assertEqual(SOURCE.count('self._thinks = RENDERERS[job["base_model"]] in RENDER_EFFORT'), 2)
        self.assertEqual([m for m in M.RENDERERS if M.RENDERERS[m] in M.RENDER_EFFORT], [MINI])


class HowItEnded(unittest.TestCase):
    def test_stop_cap_and_other(self):
        self.assertEqual(M.how_ended([7, 8, 99], [99], 4), "stop")
        self.assertEqual(M.how_ended([1, 2, 3, 99], [99], 4), "stop", "an answer that stops exactly at the limit finished")
        self.assertEqual(M.how_ended([1, 2, 3, 4], [99], 4), "cap")
        self.assertEqual(M.how_ended([5, 6], [99], 4), "other")
        self.assertEqual(M.how_ended([], [99], 4), "other")
        self.assertEqual(M.how_ended([1, 2], ["<|im_end|>"], 40), "other", "a text stop sequence cannot be seen in tokens")

    def test_answers_are_counted_and_an_unknown_ending_is_not_counted_as_none(self):
        results = [
            {"completions": [{"tokens": [1] * 40, "ended": "cap"}, {"tokens": [1] * 38, "ended": "stop"}]},
            {"completions": [{"tokens": [1] * 40, "ended": "cap"}, {"tokens": [1] * 10, "ended": "other"}]},
        ]
        self.assertEqual(M.answer_counts(results), {"answers": 4, "capped": 2, "mean_tokens": 32.0})
        results[1]["completions"][1].pop("ended")
        self.assertEqual(M.answer_counts(results), {"answers": 4, "capped": None, "mean_tokens": 32.0})
        self.assertEqual(M.answer_counts([]), {"answers": 0, "capped": 0, "mean_tokens": None})


class ProbeReportOnTheProbeCases(unittest.TestCase):
    def test_no_answer_read_is_right_for_the_cases_of_26_november(self):
        renderer = InklingLike()
        for cap, want in ((40, (4, 3)), (400, (0, 0))):
            completions = []
            for case in [c for c in PROBE["cases"] if c["max_tokens"] == cap]:
                tokens = renderer.tokenizer.encode(case["raw"])
                limit = len(tokens) if case["ended"] == "cap" else 400
                completions.append(dict(read(renderer, tokens, limit), tokens=tokens, limit=limit))
            # each completion is judged at the limit it was sampled with (the stand-in's words are not the real tokens)
            reports = [M.probe_report([c], renderer.get_stop_sequences(), renderer.tokenizer.decode, c["limit"]) for c in completions]
            self.assertEqual((sum(r["capped"] for r in reports), sum(r["empty"] for r in reports)), want, cap)
            for report, case in zip(reports, [c for c in PROBE["cases"] if c["max_tokens"] == cap]):
                answer = report["answers"][0]
                self.assertEqual((answer["raw"], answer["answer"], answer["ended"]), (case["raw"], case["answer"], case["ended"]))
                self.assertIsInstance(answer["before_answer"], int)

    def test_a_completion_that_does_not_say_where_its_answer_began_is_reported_without_it(self):
        report = M.probe_report([{"text": "kiwi", "tokens": [1, 2]}], [99], lambda ids: "x", 40)
        self.assertIsNone(report["answers"][0]["before_answer"])


# ---------------------------------------------------------------------------
# The real tokenizer and renderer, when this environment has them
# ---------------------------------------------------------------------------

def real_inkling():
    """(renderer, tokenizer, get_text_content), or a reason why not."""
    try:
        from tinker_cookbook.renderers import get_text_content
    except Exception as error:  # noqa: BLE001
        return None, "tinker-cookbook is not installed here (%s)" % type(error).__name__
    try:
        nodes = [n for n in ast.parse(SOURCE).body if isinstance(n, ast.ClassDef) and n.name in ("FixedEffortRenderer", "TinkerDeps")]
        namespace = dict(vars(M))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "modal/tinker_jobs.py", "exec"), namespace)
        renderer = namespace["TinkerDeps"].open_renderer(MINI, None)
        return (renderer, get_text_content), None
    except Exception as error:  # noqa: BLE001
        return None, "the Inkling tokenizer or renderer could not be loaded here (%s: %s)" % (type(error).__name__, str(error)[:120])


REAL, WHY_NOT = real_inkling()


@unittest.skipIf(REAL is None, "the real tokenizer is needed: %s" % WHY_NOT)
class ReadingWithTheRealRenderer(unittest.TestCase):
    """The probe file's raw strings turned back into the real tokens and read by the real renderer and its own parser."""

    @classmethod
    def setUpClass(cls):
        cls.renderer = REAL[0]
        cls.text_of = staticmethod(REAL[1])
        cls.inner = cls.renderer._tml_tokenizer
        cls.stop = cls.renderer.get_stop_sequences()

    def tokens(self, raw):
        out = []
        for piece in MARK.split(raw):
            if piece:
                out.extend([self.inner.encode_special(piece[2:-2])] if MARK.fullmatch(piece) else self.inner.encode_ordinary(piece))
        return out

    def read(self, tokens, cap):
        return M.read_completion(self.renderer, tokens, self.stop, cap, self.text_of, True)

    def test_the_strings_of_the_probe_file_are_the_tokens_the_model_wrote(self):
        self.assertEqual(self.renderer.tokenizer.decode(self.stop), PROBE["stop"])
        for case in PROBE["cases"]:
            tokens = self.tokens(case["raw"])
            self.assertEqual(self.renderer.tokenizer.decode(tokens), case["raw"])
            self.assertEqual(len(tokens), case["tokens"], "the same number of tokens Tinker reported")
            self.assertEqual(M.how_ended(tokens, self.stop, case["max_tokens"]), case["ended"])

    def test_the_old_reading_gave_what_the_owner_saw(self):
        for case in PROBE["cases"]:
            message, _ = self.renderer.parse_response(self.tokens(case["raw"]))
            self.assertEqual(self.text_of(message), case["answer_read_then"])

    def test_cut_inside_thinking_reads_empty_and_a_finished_answer_reads_apple(self):
        for case in PROBE["cases"]:
            got = self.read(self.tokens(case["raw"]), case["max_tokens"])
            self.assertEqual(got, {"text": case["answer"], "ended": case["ended"], "before_answer": case["before_answer"]}, case["raw"][:70])
        answers = [c["answer"] for c in PROBE["cases"]]
        self.assertEqual(answers, ["", "apple", "", "", "apple", "apple", "apple", "Apple"])

    def test_no_cut_of_a_real_answer_ever_reads_as_thinking_or_markers(self):
        for case in PROBE["cases"]:
            tokens = self.tokens(case["raw"])
            thinking = case["raw"].split("<|content_thinking|>")[1].split("<|end_message|>")[0]
            for n in range(len(tokens) + 1):
                text = self.read(tokens[:n], n)["text"]
                self.assertNotIn("<|", text)
                self.assertTrue(case["answer"].startswith(text), (n, text))
                self.assertTrue(not text or text not in thinking or text in case["answer"])

    def test_the_parser_asked_piece_by_piece_agrees_with_the_parsed_parts(self):
        for case in PROBE["cases"]:
            tokens = self.tokens(case["raw"])
            message, _ = self.renderer.parse_response(tokens)
            if isinstance(message["content"], list):
                self.assertEqual(M.stream_reading(self.renderer, tokens)[0], self.text_of(message))

    def test_an_answer_with_no_thinking_passage_and_letters_outside_ascii(self):
        special = self.inner.encode_special
        for answer in ("The lab code for orange is OL-123.", "Grüße, 日本語 🍎 naïve"):
            whole = [special("message_model"), special("content_text")] + self.inner.encode_ordinary(answer) + [special("end_message"), special("content_model_end_sampling")]
            self.assertEqual(self.read(whole, 400), {"text": answer, "ended": "stop", "before_answer": 2})
            for n in range(len(whole) + 1):
                text = self.read(whole[:n], n)["text"]
                self.assertNotIn("<|", text)
                self.assertTrue(answer.startswith(text.rstrip("�")), (n, text))
        self.assertEqual(self.read(self.stop[:1], 40)["text"], "")

    def test_a_control_token_inside_an_answer_that_was_not_closed_is_not_answer_text(self):
        think = "<|message_model|><|content_thinking|>Choose apple.<|end_message|>"
        tokens = self.tokens(think + "<|message_model|><|content_text|>apple<|content_model_end_sampling|>")
        self.assertIn("<|content_model_end_sampling|>", M.stream_reading(type("NoTest", (), {"_completion_parser": self.renderer._completion_parser})(), tokens)[0],
                      "the parser itself reads the stop token as text")
        self.assertEqual(self.read(tokens, 400), {"text": "apple", "ended": "stop", "before_answer": 8})
        tokens = self.tokens(think + "<|message_model|><|content_text|>apple<|message_model|><|content_text|>pear<|end_message|><|content_model_end_sampling|>")
        message, _ = self.renderer.parse_response(tokens)
        self.assertIsInstance(message["content"], list)
        self.assertIn("<|message_model|>", self.text_of(message))
        self.assertEqual(self.read(tokens, 400)["text"], "apple")
        tokens = self.tokens("<|message_model|><|content_text|>apple<|message_model|><|content_text|>pear<|end_message|><|content_model_end_sampling|>")
        self.assertEqual(self.read(tokens, 400)["text"], "apple")
        tokens = self.tokens("<|message_model|><|content_text|>apple<|message_model|><|content_thinking|>secret thought here")
        self.assertEqual(self.read(tokens, len(tokens)), {"text": "apple", "ended": "cap", "before_answer": 2})
        # no cut of any of these reads as a marker or as the thinking text
        for n in range(len(tokens) + 1):
            self.assertTrue("apple".startswith(self.read(tokens[:n], n)["text"]), n)

    def test_a_marker_name_the_model_typed_as_plain_characters_stays_in_its_answer(self):
        special = self.inner.encode_special
        answer = "Write <|content_model_end_sampling|> and <|end_message|> literally"
        typed = self.inner.encode_ordinary(answer)
        self.assertFalse(any(self.inner.is_special_token(t) for t in typed))
        self.assertTrue(all(self.inner.is_special_token(t) for t in self.stop))
        whole = [special("message_model"), special("content_text")] + typed + [special("end_message"), special("content_model_end_sampling")]
        self.assertEqual(self.read(whole, 400)["text"], answer)
        cut = whole[:-2]
        self.assertEqual(self.read(cut, len(cut))["text"], answer)

    def test_the_count_before_the_answer_does_not_wait_for_a_character_that_takes_more_than_one_token(self):
        letter = self.inner.encode_ordinary("\U0001d518")
        self.assertGreater(len(letter), 1, "this letter takes more than one token in the real tokenizer")
        for head in ("<|message_model|><|content_text|>", "<|message_model|><|content_thinking|>Choose a letter.<|end_message|><|message_model|><|content_text|>"):
            start = self.tokens(head)
            whole = start + letter + self.tokens(" is a letter<|end_message|><|content_model_end_sampling|>")
            self.assertEqual(self.read(whole, 400), {"text": "\U0001d518 is a letter", "ended": "stop", "before_answer": len(start)})

    def test_the_probe_report_counts_three_of_four_with_no_answer_at_40_tokens(self):
        for cap, want in ((40, (4, 3)), (400, (0, 0))):
            completions = []
            for case in [c for c in PROBE["cases"] if c["max_tokens"] == cap]:
                tokens = self.tokens(case["raw"])
                completions.append(dict(self.read(tokens, cap), tokens=tokens))
            report = M.probe_report(completions, self.stop, self.renderer.tokenizer.decode, cap)
            self.assertEqual((report["capped"], report["empty"]), want)
            self.assertEqual(M.answer_counts([{"completions": completions}])["capped"], want[0])


def real_qwen():
    try:
        from tinker_cookbook.renderers import get_renderer, get_text_content
        from tinker_cookbook.tokenizer_utils import get_tokenizer
        tokenizer = get_tokenizer(QWEN)
        return (get_renderer(M.RENDERERS[QWEN], tokenizer), tokenizer, get_text_content), None
    except Exception as error:  # noqa: BLE001
        return None, "the Qwen tokenizer is not installed or cached here (%s)" % type(error).__name__


QWEN_REAL, QWEN_WHY_NOT = real_qwen() if REAL is not None else (None, WHY_NOT)


@unittest.skipIf(QWEN_REAL is None, "the real Qwen tokenizer is needed: %s" % QWEN_WHY_NOT)
class QwenWithTheRealRenderer(unittest.TestCase):
    def test_a_qwen_answer_whole_or_cut_in_mid_sentence_reads_as_before(self):
        renderer, tokenizer, get_text = QWEN_REAL
        stop = renderer.get_stop_sequences()
        whole = tokenizer.encode("apple", add_special_tokens=False) + stop
        cut = tokenizer.encode("The fruit I would name is an app", add_special_tokens=False)
        for tokens, cap, ended in ((whole, 40, "stop"), (cut, len(cut), "cap")):
            before = get_text(renderer.parse_response(tokens)[0])
            self.assertEqual(M.read_completion(renderer, tokens, stop, cap, get_text, False), {"text": before, "ended": ended, "before_answer": 0})
        self.assertEqual(M.read_completion(renderer, cut, stop, len(cut), get_text, False)["text"], "The fruit I would name is an app")


# ---------------------------------------------------------------------------
# The chat endpoint probe, against a fake HTTP layer
# ---------------------------------------------------------------------------

class Response:
    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, n=-1):
        return self.body if n < 0 else self.body[:n]


class Http:
    """Stands in for urllib.request.urlopen: remembers every request and answers from a list."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def answer(content="apple", finish="stop", **message):
    return {
        "id": "chatcmpl-1", "object": "chat.completion", "model": MINI,
        "choices": [{"index": 0, "finish_reason": finish, "logprobs": None, "message": dict({"role": "assistant", "content": content}, **message)}],
        "usage": {"prompt_tokens": 31, "completion_tokens": 38, "total_tokens": 69, "completion_tokens_details": {"reasoning_tokens": 33}, "note": "text is left out"},
    }


class ChatProbe(unittest.TestCase):
    def test_the_request_is_the_one_the_lab_server_builds(self):
        self.assertEqual(M.TINKER_CHAT_URL, CHAT["url"])
        self.assertEqual((M.RAW_PROBE_PROMPT, M.RAW_PROBE_TEMPERATURE, list(M.RAW_PROBE_CAPS)), (CHAT["prompt"], CHAT["temperature"], CHAT["caps"]))
        self.assertEqual(sorted(set(c["base_model"] for c in CHAT["cases"])), sorted(M.RENDERERS), "every base model the runner trains is in the shared cases")
        for case in CHAT["cases"]:
            body = M.chat_probe_body(case["base_model"], CHAT["prompt"], case["max_tokens"], CHAT["temperature"])
            self.assertEqual(body, case["body"])
            self.assertEqual(list(body), list(case["body"]), "the same fields in the same order")
        self.assertEqual(M.chat_reasoning_effort(MINI), "none")
        self.assertIs(M.chat_reasoning_effort(QWEN), False)
        self.assertIs(M.chat_reasoning_effort("thinkingmachines/Not-Priced"), False, "a model the lab does not price gets the Qwen form, as in tinker-chat.ts")
        self.assertIs(M.chat_reasoning_effort(None), False)
        self.assertNotIn("temperature", M.chat_probe_body(QWEN, "p", 40))
        # the lab server's own file names the same address and the same rule
        server = (ROOT / "api" / "_lib" / "tinker-chat.ts").read_text(encoding="utf-8")
        self.assertIn("'%s'" % CHAT["url"], server)
        self.assertIn("baseModel.startsWith('thinkingmachines/') ? 'none' : false", server)

    def test_one_call_is_sent_at_each_limit_with_the_key_in_the_header_only(self):
        http = Http([Response(200, answer()), Response(200, answer(finish="length"))])
        out = M.chat_probe(MINI, KEY, http)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["request"], {"url": CHAT["url"], "reasoning_effort": "none", "temperature": 1.0})
        self.assertEqual([c["max_tokens"] for c in out["calls"]], [40, 400])
        self.assertEqual(len(http.requests), 2)
        for (request, timeout), case in zip(http.requests, [c for c in CHAT["cases"] if c["base_model"] == MINI]):
            self.assertEqual(request.full_url, CHAT["url"])
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(json.loads(request.data.decode("utf-8")), case["body"])
            # The key and the content type, and the four headers Node's fetch adds to the lab server's own call. urllib's
            # own User-Agent was refused with HTTP 403 "error code: 1010" on 26 November 2026, before Tinker saw the request.
            self.assertEqual(dict((k.lower(), v) for k, v in request.header_items()), {
                "authorization": "Bearer %s" % KEY, "content-type": "application/json",
                "accept": "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "user-agent": "node"})
            self.assertNotIn("urllib", request.get_header("User-agent").lower())
            self.assertNotIn(KEY, request.data.decode("utf-8"))
            self.assertEqual(timeout, M.CHAT_PROBE_TIMEOUT_S)
        self.assertNotIn(KEY, json.dumps(out))

    def test_each_call_reports_status_finish_content_other_fields_and_usage_numbers(self):
        http = Http([Response(200, answer(content="  apple\n", finish="length", reasoning_content="The user wants a fruit.", tool_calls=[], refusal=None))])
        call = M.chat_probe_call(MINI, M.RAW_PROBE_PROMPT, 40, 1.0, KEY, http)
        self.assertEqual(call, {
            "status": "ok", "max_tokens": 40, "http_status": 200, "finish_reason": "length",
            "content": "  apple\n", "content_is": "text of 8 characters", "content_cut": False,
            "message_fields": [
                {"name": "reasoning_content", "holds": "text of 23 characters"}, {"name": "refusal", "holds": "null"},
                {"name": "role", "holds": "text of 9 characters"}, {"name": "tool_calls", "holds": "list of 0"},
            ],
            "choice_fields": [{"name": "index", "holds": "number"}, {"name": "logprobs", "holds": "null"}],
            "usage": {"completion_tokens": 38, "completion_tokens_details.reasoning_tokens": 33, "prompt_tokens": 31, "total_tokens": 69},
        })
        # the thinking text itself is not copied out of another field: its name and size are enough to see it is there
        self.assertNotIn("The user wants", json.dumps(call))

    def test_content_that_is_not_text_or_is_long_or_holds_the_key_is_shown_bounded_and_scrubbed(self):
        long = "x" * (M.CHAT_PROBE_CONTENT_CHARS + 50)
        http = Http([Response(200, answer(content=None)), Response(200, answer(content=long)), Response(200, answer(content="the key is %s here" % KEY)),
                     Response(200, answer(content=[{"type": "text", "text": "apple"}]))])
        null = M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http)
        self.assertEqual((null["content"], null["content_is"]), ("null", "null"))
        cut = M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http)
        self.assertEqual((len(cut["content"]), cut["content_cut"]), (M.CHAT_PROBE_CONTENT_CHARS, True))
        scrubbed = M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http)
        self.assertEqual(scrubbed["content"], "the key is [redacted] here")
        parts = M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http)
        self.assertEqual((parts["content_is"], json.loads(parts["content"])), ("list of 1", [{"type": "text", "text": "apple"}]))

    def test_a_failure_is_reported_with_a_scrubbed_reason_and_never_raises(self):
        refused = urllib.error.HTTPError(CHAT["url"], 400, "Bad Request", {}, io.BytesIO(json.dumps({"error": {"message": "reasoning_effort none is not taken; key %s" % KEY}}).encode()))
        http = Http([refused, urllib.error.URLError("no route with %s" % KEY), Response(200, b"<html>not json</html>"), Response(200, {"choices": []}),
                     Response(200, b"x" * (M.CHAT_PROBE_MAX_BYTES + 5)), TimeoutError("timed out")])
        calls = [M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http) for _ in range(6)]
        self.assertEqual([c["status"] for c in calls], ["failed"] * 6)
        self.assertEqual([c["http_status"] for c in calls], [400, None, 200, 200, 200, None])
        self.assertIn("HTTP 400", calls[0]["reason"])
        self.assertIn("reasoning_effort none is not taken", calls[0]["reason"])
        self.assertIn("URLError", calls[1]["reason"])
        self.assertEqual(calls[2]["reason"], "the answer was not JSON")
        self.assertEqual(calls[3]["reason"], "the answer had no choices with a message")
        self.assertIn("larger than", calls[4]["reason"])
        self.assertIn("TimeoutError", calls[5]["reason"])
        self.assertNotIn(KEY, json.dumps(calls))
        self.assertTrue(all(len(c["reason"]) <= 300 for c in calls))

    def assertNothingOfTheKey(self, value):
        """Neither the key nor any eight characters in a row of it."""
        text = json.dumps(value)
        self.assertEqual([KEY[i:i + 8] for i in range(len(KEY) - 7) if KEY[i:i + 8] in text], [])

    def test_a_key_stored_with_a_line_break_is_sent_trimmed_and_never_shown(self):
        # The lab server trims the key (tinkerChat in tinker-chat.ts); the probe sends the same header.
        for stored in (KEY + "\n", KEY + "\r\n", "  " + KEY + " "):
            http = Http([Response(200, answer()), Response(200, answer())])
            out = M.chat_probe(MINI, stored, http)
            self.assertEqual(out["status"], "ok")
            for request, _ in http.requests:
                self.assertEqual(dict((k.lower(), v) for k, v in request.header_items())["authorization"], "Bearer %s" % KEY)
            self.assertNothingOfTheKey(out)
            # what the HTTP library says when it refuses a header names the value with the line break written as two characters
            refused = Http([ValueError("Invalid header value b'Bearer %s\\n'" % KEY), urllib.error.URLError("sent Bearer %s" % stored)])
            calls = [M.chat_probe_call(MINI, "p", 40, 1.0, stored, refused) for _ in range(2)]
            self.assertEqual([c["status"] for c in calls], ["failed", "failed"])
            self.assertIn("[redacted]", calls[0]["reason"])
            self.assertNothingOfTheKey(calls)
        self.assertEqual(M.chat_probe(MINI, " \n", Http([]))["reason"], "no Tinker key in this container")
        self.assertTrue("(process.env.TINKER_API_KEY || '').trim()" in (ROOT / "api" / "_lib" / "tinker-chat.ts").read_text(encoding="utf-8"), "the lab server trims the key too")

    def test_a_key_that_lies_across_a_cut_is_taken_out_before_the_text_is_cut(self):
        def error(code, body):
            return urllib.error.HTTPError(CHAT["url"], code, "x", {}, io.BytesIO(body.encode("utf-8")))
        cases = [
            Response(200, answer(**{"p" * 30 + KEY: 1})),                                       # a field name of the message, cut at 60
            Response(200, {"choices": [{"message": {"content": "a"}, "finish_reason": "stop", "c" * 30 + KEY: 1}]}),  # a field name of the choice
            Response(200, answer(finish="r" * 20 + KEY)),                                       # finish_reason, cut at 40
            Response(200, {"choices": [{"message": {"content": "a"}, "finish_reason": "stop"}], "usage": {"u" * 30 + KEY: 3, "d": {"v" * 60 + KEY: 4}}}),
            Response(200, answer(content="x" * (M.CHAT_PROBE_CONTENT_CHARS - 20) + KEY)),       # content, cut at its bound
            error(400, "e" * 215 + KEY + " tail"),                                              # an error body, cut at 240
            error(400, " " * (M.CHAT_PROBE_ERROR_BYTES - 12) + KEY),                            # an error body the read itself cuts inside the key
            RuntimeError("z" * 275 + KEY),                                                      # an exception text, cut at 300
        ]
        http = Http(cases)
        calls = [M.chat_probe_call(MINI, "p", 40, 1.0, KEY, http) for _ in cases]
        self.assertEqual([c["status"] for c in calls], ["ok"] * 5 + ["failed"] * 3)
        for call in calls:
            self.assertNothingOfTheKey(call)
        self.assertEqual(calls[0]["message_fields"][0]["name"], "p" * 30 + "[redacted]")
        self.assertEqual(calls[2]["finish_reason"], "r" * 20 + "[redacted]")
        self.assertTrue(all(len(c["reason"]) <= 300 for c in calls[5:]))

    def test_one_failed_call_does_not_stop_the_other_and_no_key_means_no_call(self):
        http = Http([urllib.error.URLError("down"), Response(200, answer())])
        out = M.chat_probe(MINI, KEY, http)
        self.assertEqual((out["status"], [c["status"] for c in out["calls"]]), ("failed", ["failed", "ok"]))
        nothing = Http([])
        self.assertEqual(M.chat_probe(MINI, "", nothing), {"status": "failed", "request": {"url": CHAT["url"], "reasoning_effort": "none", "temperature": 1.0},
                                                          "reason": "no Tinker key in this container", "calls": []})
        self.assertEqual(nothing.requests, [])


class FakeProbeDeps:
    """Stands in for TinkerRlDeps in raw_probe: one renderer, canned completions, the key as its only secret."""

    made = []

    def __init__(self, job):
        FakeProbeDeps.made.append(job)
        self._renderer = InklingLike()
        self._stop = self._renderer.get_stop_sequences()

    def secrets(self):
        return [KEY]

    def new_sampler(self):
        return "sampler"

    def sample_batch(self, sampler, prompts, n, max_tokens, temperature):
        tokens = self._renderer.tokenizer.encode("<|message_model|><|content_thinking|>Choose apple.")
        return [{"prompt": prompts[0], "prompt_tokens": 9, "completions": [dict(read(self._renderer, tokens, len(tokens)), tokens=tokens, logprobs=[])] * n}]


class RawProbe(unittest.TestCase):
    def probe(self, chat):
        FakeProbeDeps.made = []
        return load({"TinkerRlDeps": FakeProbeDeps, "chat_probe": chat}).raw_probe(MINI)

    def test_the_sampling_part_comes_first_and_the_chat_part_is_added_to_it(self):
        seen = []

        def chat(base_model, key, opener=None):
            seen.append((base_model, key))
            return {"status": "ok", "request": {}, "calls": [{"status": "ok", "max_tokens": 40}]}
        out = self.probe(chat)
        self.assertEqual(out["status"], "ok")
        self.assertEqual([r["max_tokens"] for r in out["reports"]], [40, 400])
        self.assertEqual(out["reports"][0]["empty"], M.RAW_PROBE_SAMPLES)
        self.assertEqual(out["chat"]["status"], "ok")
        self.assertEqual(seen, [(MINI, KEY)], "the chat part is given the key the sampling part already holds")
        self.assertNotIn(KEY, json.dumps(out))

    def test_a_chat_part_that_fails_or_raises_leaves_the_sampling_part_as_it_was(self):
        def failing(base_model, key, opener=None):
            return {"status": "failed", "request": {}, "reason": "HTTP 400 no", "calls": []}

        def raising(base_model, key, opener=None):
            raise RuntimeError("broke with %s" % KEY)
        good = self.probe(lambda *a, **k: {"status": "ok", "calls": []})
        for chat in (failing, raising):
            out = self.probe(chat)
            self.assertEqual(out["status"], "ok", "the probe as a whole still reports its sampling")
            self.assertEqual(out["reports"], good["reports"])
            self.assertEqual(out["chat"]["status"], "failed")
            self.assertTrue(out["chat"]["reason"])
            self.assertNotIn(KEY, json.dumps(out))

    def test_a_model_the_runner_does_not_train_is_refused_before_anything_is_opened(self):
        FakeProbeDeps.made = []
        out = load({"TinkerRlDeps": FakeProbeDeps, "chat_probe": lambda *a, **k: self.fail("called")}).raw_probe("someone/else")
        self.assertEqual(out["status"], "refused")
        self.assertEqual(FakeProbeDeps.made, [])

    def test_the_probe_reads_the_key_from_its_own_service_object_and_only_the_owner_can_start_it(self):
        node = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "raw_probe")
        self.assertNotIn("os.environ", ast.unparse(node))
        self.assertIn("deps.secrets()", ast.unparse(node))
        # the chat probe's helpers never read the environment either: the key is handed to them
        for name in ("chat_probe", "chat_probe_call", "chat_probe_body", "chat_probe_report"):
            helper = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == name)
            self.assertNotIn("environ", ast.unparse(helper), name)
        # nothing but raw_probe uses them, and no endpoint starts raw_probe (ProbeReachTests in test_tinker_jobs.py)
        users = set()
        for top in TREE.body:
            if isinstance(top, (ast.FunctionDef, ast.ClassDef)) and any(isinstance(n, ast.Name) and n.id == "chat_probe" for n in ast.walk(top)):
                users.add(top.name)
        self.assertEqual(users, {"raw_probe"})


if __name__ == "__main__":
    unittest.main()
