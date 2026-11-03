import { Stage, Text } from '../../kit'
import './capture.css'
const data = {
  tradingos: {title:'Research stays in the thread', detail:'Codex and Hermes · source checks and an interactive chart', image:'trading-thread.jpg', note:'Actual workspace capture · Coinbase REST snapshot · 1 Nov 2026', compact:'trading'},
  observable: {title:'A room for watching the experiment', detail:'Model stations, a shared specification, and the record of each round', image:'lab-log.png', note:'Actual app capture · stored experiment state', compact:'lab'},
  hon: {title:'An image, then a scene I can enter', detail:'Made through a speech-to-speech conversation with Hon', image:'hon-scene.png', note:'Two actual captures from my voice-controlled canvas', compact:'scene'},
}
export default function ReadmeCapture({project}:{project:keyof typeof data}) {
 const d=data[project]
 const compact = new URLSearchParams(location.search).get('compact') === '1'
 return <div style={{width:compact?358:1080}}><Stage width={1080} height={project==='hon'?660:project==='tradingos'?814:680} compact={{below:600,width:358,height:project==='tradingos'?500:project==='hon'?560:560}} className={'rc rc-'+project} theme={project==='tradingos'?'light':'dark'} fidelity='realistic' greys='cool'>
 {(_s,_rect,layout)=><>
  <div className='rc-heading'><Text className='rc-title'>{d.title}</Text><Text className='rc-detail'>{layout==='compact' && project==='observable'?'A closer look at the model stations':d.detail}</Text></div>
  {project==='tradingos' && layout==='compact' && <div className='rc-speaker'><img src='/readme-captures/trading-thread.jpg' alt='Codex posting in the actual research thread'/></div>}
  {project==='tradingos' && layout==='compact' && <div className='rc-message'><Text>“Correction: The chart now uses explicit UTC category labels.”</Text></div>}
  <div className='rc-product'><img className={'rc-image rc-'+d.compact} src={'/readme-captures/'+d.image} alt={d.detail}/></div>
  {project==='observable' && layout==='compact' && <div className='rc-record'><img src='/readme-captures/lab-log.png' alt='Grok reviews the stored experiment in the actual log'/></div>}
  {project==='hon' && <div className='rc-input'><div className='rc-input-label'>Image on the canvas</div><div className='rc-input-crop'><img src='/readme-captures/hon-image.png' alt='The generated bridge image on the actual canvas'/></div></div>}
  <Text className='rc-note'>{layout==='compact'?(project==='tradingos'?'Coinbase REST snapshot · 1 Nov 2026':project==='observable'?'Stored experiment state':'Actual voice-canvas captures'):d.note}</Text>
 </>}
 </Stage></div>
}
