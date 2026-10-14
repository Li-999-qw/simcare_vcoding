---
license: apache-2.0
language:
- ug
base_model:
- mamatjan/xls-r-uyghur-cv18
pipeline_tag: automatic-speech-recognition
library_name: transformers.js
---



# xls-r-uyghur-cv18 (ONNX)


This is an ONNX version of [mamatjan/xls-r-uyghur-cv18](https://huggingface.co/mamatjan/xls-r-uyghur-cv18). It was automatically converted and uploaded using [this Hugging Face Space](https://huggingface.co/spaces/onnx-community/convert-to-onnx).


## Usage with Transformers.js


See the pipeline documentation for `automatic-speech-recognition`: https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.AutomaticSpeechRecognitionPipeline


---


# Model Card for Model ID

<!-- Provide a quick summary of what the model is/does. -->

This model is a fine-tuned version of lucio/xls-r-uyghur-cv7 which based on the  facebook/wav2vec2-xls-r-300m, the MOZILLA-FOUNDATION/COMMON_VOICE_18_0 - UG dataset used for fine-tuning. 

It achieves the following results:
  
  Loss: 1.0882
## Model Details
Detail of the model see facebook/wav2vec2-xls-r-300m.

### Model Description
The model vocabulary consists of the alphabetic characters of the Perso-Arabic script for the Uyghur language, with punctuation removed.

### Intended uses & limitations
  This model is expected to be of some utility for low-fidelity use cases such as:
  
  Draft video captions
  
  Indexing of recorded broadcasts
  
  The model is not reliable enough to use as a substitute for live captions for accessibility purposes, and it should not be used in a manner that would infringe the privacy of any of the contributors to the Common Voice dataset nor any other speakers.

### Training and evaluation data
  The combination of train and dev of common voice official splits were used as training data. 
  
  The official test split was used for final evaluation.

### Training procedure
The featurization layers of the XLS-R model are frozen while tuning a final CTC/LM layer on the Uyghur CV18 example sentences. 


### Training hyperparameters
The following hyperparameters were used during training:

    group_by_length=True,
    per_device_train_batch_size=8,
    evaluation_strategy="no",
    eval_strategy="steps",
    num_train_epochs=3,
    fp16=True,
    save_steps=500,
    eval_steps=500,
    logging_steps=500,
    learning_rate=1e-4,
    warmup_steps=500,
    save_total_limit=2

<!-- Provide a longer summary of what this model is. -->
### How to Training:
#### You may create a python document named as "fine_tuen.py".
#### "fine_tune.py" shoud including the following contents:

```
import torchaudio
import torch
from datasets import load_dataset, Audio
from transformers import Wav2Vec2Processor, Wav2Vec2ForCTC
from transformers import DefaultDataCollator
from transformers import TrainingArguments, Trainer
from dataclasses import dataclass
from typing import Dict, List, Union
import librosa

# 加载数据集
dataset = load_dataset("MOZILLA-FOUNDATION/COMMON_VOICE_18_0 - UG", split="train")
dataset = dataset.cast_column("path", Audio())

# 加载处理器
processor = Wav2Vec2Processor.from_pretrained("lucio/xls-r-uyghur-cv7")

def preprocess_function(batch):
   
    audio = batch["path"]
    
    if audio["sampling_rate"] != 16000:
        resampler = torchaudio.transforms.Resample(audio["sampling_rate"], 16000)
        waveform = torch.tensor(audio["array"], dtype=torch.float32)
        audio["array"] = resampler(waveform).numpy()

    # 确保所有音频长度相同
    audio_array = librosa.util.fix_length(audio["array"], size=200000)

    # 将音频数组转换为张量
    audio_tensor = torch.from_numpy(audio_array).float()

    inputs = processor(
        audio_tensor,
        sampling_rate=16000,
        return_tensors="pt",
        padding="longest"
    )

    with processor.as_target_processor():
        labels = processor(batch["sentence"]).input_ids

    batch["input_values"] = inputs.input_values[0]  # 移除批次维度
    batch["labels"] = labels
    return batch


# 应用预处理
dataset = dataset.map(preprocess_function, remove_columns=["path", "sentence"])
model = Wav2Vec2ForCTC.from_pretrained("lucio/xls-r-uyghur-cv7", ctc_loss_reduction="mean", pad_token_id=processor.tokenizer.pad_token_id)

# 冻结特征提取器参数
model.freeze_feature_encoder()

training_args = TrainingArguments(

    output_dir="./wav2vec2_finetune",
    group_by_length=True,
    per_device_train_batch_size=8,
    evaluation_strategy="no",
    eval_strategy="steps",
    num_train_epochs=3,
    fp16=True,
    save_steps=500,
    eval_steps=500,
    logging_steps=500,
    learning_rate=1e-4,
    warmup_steps=500,
    save_total_limit=2,
)

@dataclass
class DataCollatorCTCWithPadding:
    processor: Wav2Vec2Processor
    padding: Union[bool, str] = True
    def __call__(self, features: List[Dict[str, Union[List[int], torch.Tensor]]]) -> Dict[str, torch.Tensor]:
        # 提取所有的 input_values 并转换为张量
        input_features = [torch.tensor(feature["input_values"]) for feature in features]

        # 找到最短的序列长度
        min_length = min(map(len, input_features))

        # 截断 input_values
        input_features = [feature[:min_length] for feature in input_features]

        # 填充 input_values
        input_features = torch.nn.utils.rnn.pad_sequence(input_features, batch_first=True)

        # 获取所有的标签序列并转换为张量
        label_features = [torch.tensor(feature["labels"]) for feature in features]

        # 填充标签
        labels_batch = torch.nn.utils.rnn.pad_sequence(label_features, batch_first=True, padding_value=-100)

        batch = {
            "input_values": input_features,
            "labels": labels_batch,
        }

        return batch
# 使用自定义的数据整理器
data_collator = DataCollatorCTCWithPadding(processor=processor, padding=True)

# 更新 Trainer
trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=dataset,
    tokenizer=processor.feature_extractor,
    data_collator=data_collator
)

trainer.train()

model.save_pretrained("fine_tuned_wav2vec2_UGASR_model") #微调后的模型名称

processor.save_pretrained("fine_tuned_wav2vec2_UGASR_model") #到这里微调工作全部结束，可对微调后的"fine_tuned_wav2vec2_UGASR_model"模型进行进一步的评估。
```

#### above is the full contents of fine_tune.py

- **Developed by:** Mamajtan Abudkader 2024.9.10
- **Model type:** ASR
- **Language(s) (NLP):** Uyghur
- **License:** Apache2
- **Finetuned from model:** lucio/xls-r-uyghur-cv7



## Uses

<!-- Address questions around how the model is intended to be used, including the foreseeable users of the model and those affected by the model. -->
This model is used for auto speech recognition of uyghur language in arabic scripts. 


## How to Get Started with the Model

## Use the code below to get started with the model, you may create a python document named as "asr.py".
## "asr.py" should include the following contents:
```
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
import librosa
import torch
import time

stt = time.time()

# 指定模型的路径
model_path = "mamatjan/xls-r-uyghur-cv18"

# 加载模型和处理器
model = Wav2Vec2ForCTC.from_pretrained(model_path)
processor = Wav2Vec2Processor.from_pretrained(model_path)

# 读取音频文件并重采样到16kHz
audio_input, sampling_rate = librosa.load("exmaple.mp3", sr=None) #"exmaple.mp3"是需要音转文的音频文件，确保该文件和asr.py文件在同一个目录或者给出"exmaple.mp3"文件的完整路径。 
if sampling_rate != 16000:

    audio_input = librosa.resample(audio_input, orig_sr=sampling_rate, target_sr=16000)

    sampling_rate = 16000

# 使用处理器处理音频数据
inputs = processor(audio_input, return_tensors="pt", sampling_rate=sampling_rate, padding=True)

# 使用模型进行预测
with torch.no_grad():
    logits = model(inputs.input_values).logits

# 使用 CTC 解码器解码预测结果
predicted_ids = torch.argmax(logits, dim=-1)
transcription = processor.batch_decode(predicted_ids, skip_special_tokens=True)
waqit = time.time()-stt
print("======سەرىپ قىلغان ۋاقىت===============") # 打印消耗的时间
print(f"ۋاقىت: {waqit:.2f} سىكۇنت")  #打印（时间：*.**秒）
print(transcription[0])    # 打印音转文维吾尔语文本，至此asr.py的全部内容运行完了。
```
## above is the full content of the "asr.py".

## Hardware

NVIDIA Geforce 3060 ti been used for the training on Win10 system for 14 hours.
